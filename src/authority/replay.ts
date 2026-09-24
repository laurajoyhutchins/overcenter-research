import type { Obligation } from '../model.ts';
import { authoritativeAbsenceEvidence, observationVerified } from '../observation/observe.ts';
import {
  emptyState,
  validateClaimFact,
  validateDelegationDischargeFact,
  validateDelegationReservationFact,
  validateEffectReleaseFact,
  validateEffectReservationFact,
  materializeObligation,
  validateExecutionAuthorityFact,
  validateGraphPatchFact,
  validateReceiptFact,
} from './facts.ts';
import type {
  ClaimFact,
  DelegationRecord,
  DelegationReservation,
  EffectReservation,
  EffectReservationFact,
  ExecutionAuthorityFact,
  FactCommit,
  HistoricalRun,
  ObligationDefinition,
  Receipt,
  ReceiptFact,
  State,
} from './facts.ts';
import { dependencyUpstreams, validateGraph } from '../graph/topology.ts';
import { settlementSemantics } from '../semantics.ts';
import {
  reservedEffectReleaseSafe,
  reservedEffectReleaseWitnessSafe,
  reservedEffectReplaySafe,
} from '../effect-adapter.ts';
import {
  delegationReservationAuthorityError,
  effectReleaseAuthorityError,
  effectReservationAuthorityError,
  executionAuthorityAdvanceError,
  receiptAuthorityError,
} from './transaction-admission.ts';
import {
  deriveProjectProjection,
  hasInFlight,
  type ProjectProjection as WorkProjection,
} from './project-state.ts';

export interface HistoryProjection {
  runs: Map<string, HistoricalRun>;
  receiptsByRun: Map<string, Receipt>;
  unresolvedReservationsByRun: Map<string, EffectReservation>;
  delegationsById: Map<string, DelegationRecord>;
  unresolvedDelegationsByRun: Map<string, Map<string, DelegationReservation>>;
  receipts: Receipt[];
  currentBindingOrdinals: Map<string, number>;
  claimOrdinalsByRun: Map<string, number>;
  authorityOrdinal: number;
}

export interface Projection {
  state: State;
  definitions: Record<string, ObligationDefinition>;
  project: WorkProjection;
  history: HistoryProjection;
}

export function projectReceipt(
  fact: ReceiptFact,
  work: Obligation,
  settlementCommit?: string,
  unresolvedEffect = false,
  notDispatchedRelease = false,
): Receipt {
  let disposition: Receipt['disposition'];
  let verified = false;

  if (fact.kind === 'observation') {
    if (!fact.observed) throw new Error('OBSERVATION_RECEIPT_MISSING_EVIDENCE');
    verified = observationVerified(work.postcondition, fact.observed);
    const policy = settlementSemantics(work.postcondition);
    const absenceEvidence = authoritativeAbsenceEvidence(work.postcondition, fact.observed);
    const acceptedAbsence =
      absenceEvidence && policy.acceptedAbsenceEvidenceKinds.includes(absenceEvidence.kind);
    const replaySafe =
      !unresolvedEffect ||
      (absenceEvidence !== null && reservedEffectReplaySafe(work, absenceEvidence));
    disposition = verified ? 'DONE' : acceptedAbsence && replaySafe ? 'READY' : 'RECOVERY_REQUIRED';
  } else {
    if (fact.observed) throw new Error('NONOBSERVATION_RECEIPT_HAS_EVIDENCE');
    disposition =
      fact.kind === 'judgment-required'
        ? 'WAITING'
        : fact.kind === 'effect-not-dispatched' && notDispatchedRelease
          ? 'READY'
          : 'RECOVERY_REQUIRED';
  }

  return {
    ...fact,
    disposition,
    verified,
    ...(settlementCommit ? { settlement_commit: settlementCommit } : {}),
  };
}

export function replayProjection(
  commits: FactCommit[],
  base: Projection | null = null,
): Projection {
  const state = base
    ? {
        obligations: { ...base.state.obligations },
        definition_ids: { ...base.state.definition_ids },
      }
    : emptyState();
  const definitions: Record<string, ObligationDefinition> = base ? { ...base.definitions } : {};
  const runs = base ? new Map(base.history.runs) : new Map<string, HistoricalRun>();
  const receiptsByRun = base ? new Map(base.history.receiptsByRun) : new Map<string, Receipt>();
  const unresolvedReservationsByRun = base
    ? new Map(base.history.unresolvedReservationsByRun)
    : new Map<string, EffectReservation>();
  const delegationsById = base
    ? new Map(base.history.delegationsById)
    : new Map<string, DelegationRecord>();
  const unresolvedDelegationsByRun = base
    ? new Map<string, Map<string, DelegationReservation>>(
        [...base.history.unresolvedDelegationsByRun].map(
          ([runId, delegations]) => [runId, new Map(delegations)] as const,
        ),
      )
    : new Map<string, Map<string, DelegationReservation>>();
  const receipts = base ? [...base.history.receipts] : [];
  const currentBindingOrdinals = base
    ? new Map(base.history.currentBindingOrdinals)
    : new Map<string, number>();
  const claimOrdinalsByRun = base
    ? new Map(base.history.claimOrdinalsByRun)
    : new Map<string, number>();
  let authorityOrdinal = base?.history.authorityOrdinal ?? 0;
  let project =
    base?.project ??
    deriveProjectProjection({
      state,
      runs,
      receiptsByRun,
      revision: '',
      currentBindingOrdinals,
      claimOrdinalsByRun,
    });

  const refresh = (revision: string): void => {
    project = deriveProjectProjection({
      state,
      runs,
      receiptsByRun,
      revision,
      currentBindingOrdinals,
      claimOrdinalsByRun,
    });
  };

  for (const record of commits) {
    authorityOrdinal += 1;
    let notDispatchedRelease = false;
    if (record.graph_patch != null) {
      refresh(record.parent ?? '');
      if (hasInFlight(project)) throw new Error('GRAPH_PATCH_WHILE_IN_FLIGHT');

      const patch = validateGraphPatchFact(record.graph_patch);
      for (const introduced of patch.definitions) {
        if (definitions[introduced.id]) {
          throw new Error(`DUPLICATE_DEFINITION:${introduced.id}`);
        }
        definitions[introduced.id] = structuredClone(introduced.definition);
      }

      for (const id of patch.retire) {
        if (!state.obligations[id]) {
          throw new Error(`RETIRE_UNKNOWN_OBLIGATION:${id}`);
        }
        delete state.obligations[id];
        delete state.definition_ids[id];
        currentBindingOrdinals.delete(id);
      }

      for (const binding of patch.bindings) {
        const definition = definitions[binding.definition_id];
        if (!definition) {
          throw new Error(`UNKNOWN_OBLIGATION_DEFINITION:${binding.definition_id}`);
        }
        state.obligations[binding.node_id] = materializeObligation(binding.node_id, definition);
        state.definition_ids[binding.node_id] = binding.definition_id;
        currentBindingOrdinals.set(binding.node_id, authorityOrdinal);
      }

      validateGraph(state);
    }

    if (record.claim != null) {
      const claim = validateClaimFact(record.claim);
      const obligation = state.obligations[claim.obligation_id];
      if (!obligation) throw new Error('CLAIM_FOR_UNKNOWN_OBLIGATION');
      if (runs.has(claim.run_id)) throw new Error('DUPLICATE_RUN');
      if (record.parent !== claim.claimed_revision) throw new Error('CLAIM_REVISION_MISMATCH');

      refresh(record.commit);
      const current = project.lifecycles.get(claim.obligation_id);
      if (current?.status !== 'UNREALIZED') throw new Error('CLAIM_WHILE_NOT_READY');
      const unsatisfied = dependencyUpstreams(obligation).filter(
        (dependency) => project.lifecycles.get(dependency)?.status !== 'DONE',
      );
      if (unsatisfied.length > 0) throw new Error('CLAIM_WITH_UNSATISFIED_DEPENDENCIES');

      const expectedKey = project.semanticKeys.get(claim.obligation_id);
      if (!expectedKey) throw new Error('CLAIM_WITH_UNRESOLVED_SEMANTIC_DEPENDENCY');
      if (claim.obligation_key !== expectedKey) throw new Error('CLAIM_OBLIGATION_KEY_MISMATCH');

      const run: HistoricalRun = {
        id: claim.run_id,
        obligation_id: claim.obligation_id,
        claimed_revision: claim.claimed_revision,
        claim_commit: record.commit,
        obligation_key: claim.obligation_key,
        execution_generation: 1,
        execution_authority_commit: record.commit,
        execution_capability_sha256: claim.execution_capability_sha256,
        obligation: structuredClone(obligation),
        definition_id: state.definition_ids[claim.obligation_id],
      };
      runs.set(run.id, run);
      claimOrdinalsByRun.set(run.id, authorityOrdinal);
    }

    if (record.execution_authority != null) {
      const fact = validateExecutionAuthorityFact(record.execution_authority);
      const run = runs.get(fact.run_id);
      if (!run) throw new Error('EXECUTION_AUTHORITY_WITHOUT_CLAIM');
      const authorityError = executionAuthorityAdvanceError(run, fact);
      if (authorityError) throw new Error(authorityError);
      refresh(record.commit);
      const current = project.lifecycles.get(run.obligation_id);
      if (
        current?.run?.id !== run.id ||
        !['EXECUTING', 'WAITING', 'RECOVERY_REQUIRED'].includes(current.status)
      ) {
        throw new Error('EXECUTION_AUTHORITY_FOR_NONCURRENT_RUN');
      }
      runs.set(run.id, {
        ...run,
        execution_generation: fact.generation,
        execution_authority_commit: record.commit,
        execution_capability_sha256: fact.execution_capability_sha256,
      });
    }

    if (record.effect_reservation != null) {
      const fact = validateEffectReservationFact(record.effect_reservation);
      const run = runs.get(fact.run_id);
      if (!run) throw new Error('EFFECT_RESERVATION_WITHOUT_CLAIM');
      const authorityError = effectReservationAuthorityError(
        run,
        fact,
        unresolvedReservationsByRun.has(run.id),
      );
      if (authorityError) throw new Error(authorityError);
      refresh(record.commit);
      const current = project.lifecycles.get(run.obligation_id);
      if (current?.run?.id !== run.id || current.status !== 'EXECUTING') {
        throw new Error('EFFECT_RESERVATION_WHILE_NOT_EXECUTING');
      }
      unresolvedReservationsByRun.set(run.id, {
        ...fact,
        reservation_commit: record.commit,
      });
    }

    if (record.effect_release != null) {
      const release = validateEffectReleaseFact(record.effect_release);
      const run = runs.get(release.run_id);
      if (!run) throw new Error('EFFECT_RELEASE_WITHOUT_CLAIM');
      const reservation = unresolvedReservationsByRun.get(run.id);
      if (!reservation) throw new Error('EFFECT_RELEASE_WITHOUT_RESERVATION');
      const authorityError = effectReleaseAuthorityError(run, reservation, release);
      if (authorityError) throw new Error(authorityError);
      if (release.effect_contract !== run.obligation.packet.effect_contract) {
        throw new Error('EFFECT_RELEASE_CONTRACT_MISMATCH');
      }
      if (release.schema_version === 1) {
        if (
          !reservedEffectReleaseSafe(run.obligation, release.effect_contract, release.evidence_kind)
        ) {
          throw new Error('EFFECT_RELEASE_EVIDENCE_NOT_AUTHORIZED');
        }
      } else {
        if (!release.evidence) throw new Error('EFFECT_RELEASE_EVIDENCE_MISSING');
        if (
          !reservedEffectReleaseWitnessSafe(run.obligation, release.effect_contract, {
            kind: release.evidence.kind,
            source: release.evidence.source,
            attempt: release.evidence.attempt,
            observation: release.evidence.observation,
          })
        ) {
          throw new Error('EFFECT_RELEASE_EVIDENCE_NOT_AUTHORIZED');
        }
      }
      if (record.receipt == null) throw new Error('EFFECT_RELEASE_WITHOUT_READY_RECEIPT');
      const paired = validateReceiptFact(record.receipt);
      if (paired.kind !== 'effect-not-dispatched') {
        throw new Error('EFFECT_RELEASE_RECEIPT_KIND_MISMATCH');
      }
      refresh(record.commit);
      const current = project.lifecycles.get(run.obligation_id);
      if (current?.run?.id !== run.id || current.status !== 'EXECUTING') {
        throw new Error('EFFECT_RELEASE_WHILE_NOT_EXECUTING');
      }
      unresolvedReservationsByRun.delete(run.id);
      notDispatchedRelease = true;
    }

    if (record.delegation_reservation != null) {
      const fact = validateDelegationReservationFact(record.delegation_reservation);
      const run = runs.get(fact.run_id);
      if (!run) throw new Error('DELEGATION_RESERVATION_WITHOUT_CLAIM');
      const authorityError = delegationReservationAuthorityError(run, fact);
      if (authorityError) throw new Error(authorityError);
      if (delegationsById.has(fact.delegation_id)) {
        throw new Error('DUPLICATE_DELEGATION_ID');
      }

      refresh(record.commit);
      const parent = project.lifecycles.get(run.obligation_id);
      if (parent?.run?.id !== run.id || parent.status !== 'EXECUTING') {
        throw new Error('DELEGATION_RESERVATION_WHILE_NOT_EXECUTING');
      }
      if (!state.obligations[fact.child_obligation_id]) {
        throw new Error('DELEGATION_CHILD_UNKNOWN');
      }
      if (fact.child_obligation_id === run.obligation_id) {
        throw new Error('DELEGATION_SELF_REFERENCE');
      }
      if (project.lifecycles.get(fact.child_obligation_id)?.status === 'DONE') {
        throw new Error('DELEGATION_CHILD_ALREADY_DONE');
      }

      const reservation: DelegationReservation = {
        ...fact,
        reservation_commit: record.commit,
      };
      delegationsById.set(fact.delegation_id, reservation);
      const unresolved = unresolvedDelegationsByRun.get(run.id) ?? new Map();
      unresolved.set(fact.delegation_id, reservation);
      unresolvedDelegationsByRun.set(run.id, unresolved);
    }

    if (record.delegation_discharge != null) {
      const fact = validateDelegationDischargeFact(record.delegation_discharge);
      const delegation = delegationsById.get(fact.delegation_id);
      if (!delegation) throw new Error('DELEGATION_DISCHARGE_WITHOUT_RESERVATION');
      if (delegation.discharge_commit) throw new Error('DUPLICATE_DELEGATION_DISCHARGE');
      if (
        fact.run_id !== delegation.run_id ||
        fact.child_obligation_id !== delegation.child_obligation_id ||
        fact.reservation_commit !== delegation.reservation_commit
      ) {
        throw new Error('DELEGATION_DISCHARGE_BINDING_MISMATCH');
      }

      const unresolved = unresolvedDelegationsByRun.get(fact.run_id);
      if (!unresolved?.has(fact.delegation_id)) {
        throw new Error('DELEGATION_DISCHARGE_NOT_OUTSTANDING');
      }

      refresh(record.commit);
      const child = project.lifecycles.get(fact.child_obligation_id);
      if (child?.status !== 'DONE' || child.run?.id !== fact.child_run_id) {
        throw new Error('DELEGATION_CHILD_NOT_DONE');
      }
      const childReceipt = receiptsByRun.get(fact.child_run_id);
      if (
        childReceipt?.disposition !== 'DONE' ||
        childReceipt.settlement_commit !== fact.child_settlement_commit
      ) {
        throw new Error('DELEGATION_CHILD_SETTLEMENT_MISMATCH');
      }

      delegationsById.set(fact.delegation_id, {
        ...delegation,
        discharge_commit: record.commit,
        child_run_id: fact.child_run_id,
        child_settlement_commit: fact.child_settlement_commit,
      });
      unresolved.delete(fact.delegation_id);
      if (unresolved.size === 0) unresolvedDelegationsByRun.delete(fact.run_id);
    }

    if (record.receipt == null) continue;
    const fact = validateReceiptFact(record.receipt);
    const run = runs.get(fact.run_id);
    if (!run) throw new Error('RECEIPT_WITHOUT_CLAIM');
    const receiptError = receiptAuthorityError(run, fact);
    if (receiptError) throw new Error(receiptError);

    refresh(record.commit);
    const current = project.lifecycles.get(run.obligation_id);
    if (current?.run?.id !== run.id) throw new Error('RECEIPT_FOR_NONCURRENT_RUN');
    if (fact.kind === 'judgment-required' && current.status !== 'EXECUTING') {
      throw new Error('JUDGMENT_REQUIRED_WHILE_NOT_EXECUTING');
    }
    if (fact.kind === 'judgment-required' && unresolvedReservationsByRun.has(run.id)) {
      throw new Error('JUDGMENT_REQUIRED_WITH_UNRESOLVED_EFFECT');
    }
    if (fact.kind === 'execution-terminated' && current.status !== 'EXECUTING') {
      throw new Error('EXECUTION_TERMINATED_WHILE_NOT_EXECUTING');
    }
    if (fact.kind === 'effect-not-dispatched' && !notDispatchedRelease) {
      throw new Error('EFFECT_NOT_DISPATCHED_RECEIPT_WITHOUT_RELEASE');
    }
    if (
      fact.kind === 'observation' &&
      !['EXECUTING', 'WAITING', 'RECOVERY_REQUIRED'].includes(current.status)
    ) {
      throw new Error('OBSERVATION_WHILE_NOT_RESOLVABLE');
    }
    const previous = receiptsByRun.get(run.id);
    if (previous && ['DONE', 'READY'].includes(previous.disposition)) {
      throw new Error('RECEIPT_AFTER_TERMINAL_SETTLEMENT');
    }

    const unresolvedEffect = unresolvedReservationsByRun.has(run.id);
    const receipt = projectReceipt(
      fact,
      run.obligation,
      record.commit,
      unresolvedEffect,
      notDispatchedRelease,
    );
    if (
      ['DONE', 'READY'].includes(receipt.disposition) &&
      (unresolvedDelegationsByRun.get(run.id)?.size ?? 0) > 0
    ) {
      throw new Error('TERMINAL_RECEIPT_WITH_UNRESOLVED_DELEGATION');
    }
    receiptsByRun.set(run.id, receipt);
    if (receipt.disposition === 'DONE' || receipt.disposition === 'READY') {
      unresolvedReservationsByRun.delete(run.id);
    }
    receipts.push(receipt);
  }

  const revision = commits.at(-1)?.commit ?? base?.project.work[0]?.revision ?? '';
  refresh(revision);
  return {
    state,
    definitions,
    project,
    history: {
      runs,
      receiptsByRun,
      unresolvedReservationsByRun,
      delegationsById,
      unresolvedDelegationsByRun,
      receipts,
      currentBindingOrdinals,
      claimOrdinalsByRun,
      authorityOrdinal,
    },
  };
}

export function advanceProjection(previous: Projection, record: FactCommit): Projection {
  return replayProjection([record], previous);
}
