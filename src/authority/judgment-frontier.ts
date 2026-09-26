import {\n  AGENT_TASK_PACKET_SCHEMA,\n  validateAgentTaskDefinition,\n} from '../execution/assignment-capsule.ts';
import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../effect-adapter.ts';
import { HOSTILE_MUTATION_EVIDENCE_PATH } from '../evidence/hostile-mutation-obligation.ts';
import { isSystemEvidenceWork } from '../evidence/system-evidence.ts';
import type { Work } from '../model.ts';
import { validateSourceTaskPacket } from '../source/source-obligation.ts';
import { isData } from '../validation.ts';
import type { ProjectExplanation } from './project-state.ts';

export const JUDGMENT_FRONTIER_SCHEMA = 'overcenter-judgment-frontier/v1' as const;

export type JudgmentFrontierRoute =
  | 'deterministic-software-action'
  | 'reasoning-required'
  | 'recovery-required'
  | 'unsupported';

export type JudgmentFrontierReasonCode =
  | 'POSTCONDITION_ALREADY_SATISFIED'
  | 'AMBIGUOUS_RESERVED_MUTATION'
  | 'RECOVERY_RECEIPT_PRESENT'
  | 'CURRENT_REALIZATION_INDETERMINATE'
  | 'DECLARED_JUDGMENT_REQUIRED'
  | 'STALE_EXACT_REVISION_EVIDENCE'
  | 'DERIVABLE_SYSTEM_EVIDENCE'
  | 'DERIVABLE_HOSTILE_EVIDENCE_DEBT'
  | 'OPEN_ENDED_SOURCE_REMEDIATION'
  | 'PURE_CANDIDATE_REQUIRES_JUDGMENT'
  | 'WORK_IN_FLIGHT'
  | 'WORK_BLOCKED'
  | 'PACKET_UNSUPPORTED'
  | 'AUTHORITY_EXPLANATION_MISMATCH';

export interface JudgmentFrontierDecision {
  schema: typeof JUDGMENT_FRONTIER_SCHEMA;
  route: JudgmentFrontierRoute;
  reason_code: JudgmentFrontierReasonCode;
  evidence_predicates: string[];
}

export interface JudgmentFrontierInput {
  work: Work;
  explanation: ProjectExplanation;
  unresolved_effect: boolean;
}

function decision(
  route: JudgmentFrontierRoute,
  reasonCode: JudgmentFrontierReasonCode,
  ...evidencePredicates: string[]
): JudgmentFrontierDecision {
  return {
    schema: JUDGMENT_FRONTIER_SCHEMA,
    route,
    reason_code: reasonCode,
    evidence_predicates: evidencePredicates,
  };
}

function explanationMatches(work: Work, explanation: ProjectExplanation): boolean {
  return explanation.obligation_id === work.id && explanation.status === work.status;
}

function isReservedSourceMutation(work: Work): boolean {
  return (
    work.packet.kind === 'source-change' &&
    work.packet.effect_contract === GITHUB_SOURCE_INTEGRATION_EFFECT
  );
}

function isDerivableHostileEvidenceDebt(work: Work): boolean {
  if (work.packet.kind !== 'source-change') return false;
  const task = validateSourceTaskPacket(work.packet);
  const evidence = task.context?.evidence;
  if (!isData(evidence) || typeof evidence.probe_id !== 'string') return false;
  if (!Array.isArray(evidence.stale_sources) || evidence.stale_sources.length === 0) return false;
  const exactStaleSources = evidence.stale_sources.every(
    (source) =>
      isData(source) &&
      typeof source.path === 'string' &&
      typeof source.expected_blob_sha1 === 'string' &&
      /^[0-9a-f]{40}$/.test(source.expected_blob_sha1) &&
      typeof source.current_blob_sha1 === 'string' &&
      /^[0-9a-f]{40}$/.test(source.current_blob_sha1) &&
      source.current === false,
  );
  return (
    work.id.startsWith('tcb:hostile-evidence-stale:') &&
    task.context?.schema === 'overcenter-tcb-finding/v1' &&
    task.context.finding_kind === 'hostile-evidence-stale' &&
    task.acceptance?.verifier === 'tcb-finding-absent/v1' &&
    task.acceptance.finding_id === work.id &&
    task.writable_paths.includes(HOSTILE_MUTATION_EVIDENCE_PATH) &&
    exactStaleSources
  );
}

export function classifyJudgmentFrontier({
  work,
  explanation,
  unresolved_effect: unresolvedEffect,
}: JudgmentFrontierInput): JudgmentFrontierDecision {
  if (!explanationMatches(work, explanation)) {
    return decision(
      'unsupported',
      'AUTHORITY_EXPLANATION_MISMATCH',
      `work.id=${work.id}`,
      `work.status=${work.status}`,
      `explanation.obligation_id=${explanation.obligation_id}`,
      `explanation.status=${explanation.status}`,
    );
  }

  if (unresolvedEffect) {
    return decision(
      'recovery-required',
      'AMBIGUOUS_RESERVED_MUTATION',
      'effect_reservation=unresolved',
      `work.status=${work.status}`,
      isReservedSourceMutation(work)
        ? `packet.effect_contract=${GITHUB_SOURCE_INTEGRATION_EFFECT}`
        : `packet.kind=${String(work.packet.kind ?? 'unknown')}`,
    );
  }

  if (work.status === 'RECOVERY_REQUIRED') {
    return decision(
      'recovery-required',
      'RECOVERY_RECEIPT_PRESENT',
      'work.status=RECOVERY_REQUIRED',
      explanation.reason.kind === 'recovery-receipt'
        ? `receipt.kind=${explanation.reason.receipt_kind}`
        : 'receipt.kind=unknown',
    );
  }

  if (work.status === 'DONE') {
    return decision(
      'deterministic-software-action',
      'POSTCONDITION_ALREADY_SATISFIED',
      'work.status=DONE',
      explanation.reason.kind === 'admissible-realization'
        ? `admissibility_basis=${explanation.reason.admissibility_basis}`
        : 'admissibility_basis=unknown',
    );
  }

  if (work.status === 'BLOCKED') {
    if (explanation.reason.kind === 'judgment-required') {
      return decision(
        'reasoning-required',
        'DECLARED_JUDGMENT_REQUIRED',
        'work.status=BLOCKED',
        'explanation.reason.kind=judgment-required',
        'postcondition.verifier=operator-judgment/v1',
      );
    }
    if (explanation.reason.kind === 'current-realization-indeterminate') {
      return decision(
        'recovery-required',
        'CURRENT_REALIZATION_INDETERMINATE',
        'work.status=BLOCKED',
        'explanation.reason.kind=current-realization-indeterminate',
        `observation.reason=${explanation.reason.reason}`,
      );
    }
    return decision(
      'unsupported',
      'WORK_BLOCKED',
      'work.status=BLOCKED',
      `explanation.reason.kind=${explanation.reason.kind}`,
    );
  }

  if (work.status === 'EXECUTING' || work.status === 'WAITING') {
    return decision(
      'unsupported',
      'WORK_IN_FLIGHT',
      `work.status=${work.status}`,
      `explanation.reason.kind=${explanation.reason.kind}`,
    );
  }

  if (isSystemEvidenceWork(work)) {
    const stale =
      explanation.reason.kind === 'claimable' &&
      explanation.reason.rejected_realization !== undefined;
    return decision(
      'deterministic-software-action',
      stale ? 'STALE_EXACT_REVISION_EVIDENCE' : 'DERIVABLE_SYSTEM_EVIDENCE',
      'work.status=READY',
      'packet.kind=system-evidence',
      stale\n        ? 'prior_realization=currently-rejected'\n        : 'prior_realization=no-current-admissible-run',
    );
  }

  if (work.packet.kind === 'source-change') {
    const task = validateSourceTaskPacket(work.packet);
    if (isDerivableHostileEvidenceDebt(work)) {
      return decision(
        'deterministic-software-action',
        'DERIVABLE_HOSTILE_EVIDENCE_DEBT',
        'work.status=READY',
        'packet.kind=source-change',
        'packet.context.finding_kind=hostile-evidence-stale',
        `packet.writable_paths includes ${HOSTILE_MUTATION_EVIDENCE_PATH}`,
        'packet.context.evidence.stale_sources=exact-nonempty-current-false',
        `packet.effect_contract=${task.effect_contract}`,
        `packet.acceptance.finding_id=${task.acceptance?.finding_id ?? 'missing'}`,
      );
    }
    return decision(
      'reasoning-required',
      'OPEN_ENDED_SOURCE_REMEDIATION',
      'work.status=READY',
      'packet.kind=source-change',
      `packet.effect_contract=${task.effect_contract}`,
    );
  }

  if (work.packet.schema === AGENT_TASK_PACKET_SCHEMA && work.packet.kind === 'pure-candidate') {
    validateAgentTaskDefinition(work.packet);
    return decision(
      'reasoning-required',
      'PURE_CANDIDATE_REQUIRES_JUDGMENT',
      'work.status=READY',
      `packet.schema=${AGENT_TASK_PACKET_SCHEMA}`,
      'packet.kind=pure-candidate',
    );
  }

  return decision(
    'unsupported',
    'PACKET_UNSUPPORTED',
    'work.status=READY',
    `packet.kind=${String(work.packet.kind ?? 'unknown')}`,
  );
}
