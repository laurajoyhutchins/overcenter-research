import { randomUUID } from 'node:crypto';
import { sha256 } from '../digest.ts';
import type {
  Data,
  ExecutionPermit,
  Observation,
  Obligation,
  Postcondition,
  Run,
  Work,
} from '../model.ts';
import type { DurableFactStore } from './store.ts';
import {
  observePostcondition,
  observePostconditionAsync,
  type ObservationContext,
} from '../observation/observe.ts';
import {
  CLAIM_SCHEMA,
  EFFECT_RELEASE_SCHEMA,
  EFFECT_RELEASE_SCHEMA_VERSION,
  EFFECT_RESERVATION_SCHEMA,
  EXECUTION_AUTHORITY_SCHEMA,
  GRAPH_PATCH_SCHEMA,
  RECEIPT_SCHEMA,
  SOURCE_REVISION_BINDING_SCHEMA,
  materializeObligation,
  normalizeObligation,
  obligationDefinition,
  obligationDefinitionId,
} from './facts.ts';
import type {
  ClaimFact,
  EffectReleaseFact,
  EffectReservationFact,
  ExecutionAuthorityFact,
  GraphPatchFact,
  HistoricalRun,
  ObligationInput,
  Receipt,
  ReceiptFact,
  ReceiptKind,
  SourceRevisionBindingFact,
} from './facts.ts';
import { validateAdmission } from './admission.ts';
import {
  deriveProjectProjection,
  explainProjectWork,
  hasInFlight,
  type ProjectExplanation,
} from './project-state.ts';
import { deriveCurrentRealizationJudgments } from './realization-reuse.ts';
import { advanceProjection, projectReceipt, replayProjection } from './replay.ts';
import type { Projection } from './replay.ts';
import { mutationAdmitted, projectExecutionAuthority } from './transaction-admission.ts';
import {
  effectAdapterCapabilities,
  reservedEffectReleaseWitnessSafe,
  type EffectVerifier,
  type RegisteredEffectContract,
} from '../effect-adapter.ts';
import {
  effectReleaseEvidenceRef,
  retainEffectReleaseEvidence,
  validateTrustedEffectReleaseWitness,
  type EffectAttemptBinding,
  type TrustedEffectReleaseWitness,
} from '../effect-release-witness.ts';
import { planGraphReconciliation } from '../graph/reconciliation.ts';
import {
  trustedSourceIntegrationEvidence,
  type TrustedSourceIntegrationWitness,
} from '../source/source-integration.ts';
import { bindSourceClaim, type SourceClaimBinding } from '../source/source-obligation.ts';

export type { Receipt } from './facts.ts';

export interface KernelOptions {
  githubToken?: string | null;
  observationContext?: Omit<ObservationContext, 'githubToken'>;
}

const effectAuthorityBrand: unique symbol = Symbol('effect-authority');
const effectAuthorityPermits = new WeakMap<object, ExecutionPermit>();

export type EffectAuthority<E extends string, V extends Postcondition['verifier']> = {
  readonly [effectAuthorityBrand]: E;
  readonly postcondition: Extract<Postcondition, { verifier: V }>;
};

function effectAuthorityPermit(authority: object): ExecutionPermit {
  const permit = effectAuthorityPermits.get(authority);
  if (!permit) throw new Error('EFFECT_AUTHORITY_INVALID');
  return permit;
}

export interface GraphPatchInput {
  upsert?: ObligationInput[];
  retire?: string[];
}

export interface ClaimOptions {
  sourceRevision?: string;
}

export interface GraphReconciliationResult {
  revision: string;
  added: string[];
  rebound: string[];
  retired: string[];
  unchanged: string[];
}

export interface GraphReconciliationOptions {
  retireMissingPrefixes?: readonly string[];
}

export class KernelCore {
  readonly githubToken: string | null;
  readonly observationContext: ObservationContext;
  readonly #store: DurableFactStore;
  // Reconstructible acceleration only: history(head) is still fully validated first.
  #projectionCache: { head: string; commitCount: number; projection: Projection } | null = null;

  constructor(
    store: DurableFactStore,
    { githubToken = null, observationContext = {} }: KernelOptions = {},
  ) {
    this.#store = store;
    this.githubToken = githubToken;
    this.observationContext = { githubToken, ...observationContext };
  }

  initialize(): string {
    const existing = this.head();
    if (existing) return existing;
    const commit = this.#store.append(null, 'overcenter: initialize');
    if (commit) return commit;
    const winner = this.head();
    if (!winner) throw new Error('INITIALIZE_LOST');
    this.#historicalProjection(winner);
    return winner;
  }

  head(): string | null {
    return this.#store.head();
  }

  define(input: ObligationInput): string {
    const obligation = normalizeObligation(input);
    const head = this.#requireHead();
    const projection = this.#historicalProjection(head);
    if (projection.state.obligations[obligation.id]) {
      throw new Error(`duplicate obligation: ${obligation.id}`);
    }
    return this.#commitGraphPatch(projection, [obligation], [], head);
  }

  applyGraphPatch({ upsert = [], retire = [] }: GraphPatchInput, expectedRevision: string): string {
    const head = this.#requireHead();
    if (head !== expectedRevision) throw new Error('STALE_REVISION');
    if (upsert.length === 0 && retire.length === 0) {
      throw new Error('EMPTY_GRAPH_PATCH');
    }

    return this.#commitGraphPatch(
      this.#historicalProjection(head),
      upsert.map(normalizeObligation),
      retire,
      head,
    );
  }

  reconcileGraph(
    desired: ObligationInput[],
    expectedRevision: string,
    { retireMissingPrefixes = [] }: GraphReconciliationOptions = {},
  ): GraphReconciliationResult {
    const head = this.#requireHead();
    if (head !== expectedRevision) throw new Error('STALE_REVISION');

    const projection = this.#historicalProjection(head);
    const plan = planGraphReconciliation(projection.state, desired, retireMissingPrefixes);
    if (plan.upsert.length === 0 && plan.retire.length === 0) {
      return {
        revision: head,
        added: [],
        rebound: [],
        retired: [],
        unchanged: plan.unchanged,
      };
    }

    const revision = this.#commitGraphPatch(projection, plan.upsert, plan.retire, head);
    return {
      revision,
      added: plan.added,
      rebound: plan.rebound,
      retired: plan.retire,
      unchanged: plan.unchanged,
    };
  }

  inspect(): Work[] {
    const head = this.#requireHead();
    return this.#currentProjection(head).project.work;
  }

  claimedWork(identity: string | ExecutionPermit): Work {
    const runId = typeof identity === 'string' ? identity : identity.id;
    const run = this.#historicalProjection(this.#requireHead()).history.runs.get(runId);
    if (!run) throw new Error('UNKNOWN_RUN');
    const work = this.#historicalProjection(run.claim_commit).project.work.find(
      (candidate) => candidate.id === run.obligation_id,
    );
    if (
      !work ||
      work.status !== 'EXECUTING' ||
      work.run_id !== runId ||
      work.claimed_revision !== run.claimed_revision ||
      work.revision !== run.claim_commit ||
      (typeof identity !== 'string' &&
        (identity.obligation_id !== run.obligation_id ||
          identity.claimed_revision !== run.claimed_revision))
    ) {
      throw new Error(
        typeof identity === 'string'
          ? 'CLAIMED_WORK_RECONSTRUCTION_FAILED'
          : 'EFFECT_AUTHORITY_RUN_MISMATCH',
      );
    }
    return structuredClone(work);
  }

  authorizeEffect<E extends RegisteredEffectContract | undefined = undefined>(
    permit: ExecutionPermit,
    effectContract?: E,
  ): E extends RegisteredEffectContract
    ? EffectAuthority<E, EffectVerifier<Extract<E, RegisteredEffectContract>>>
    : EffectAuthority<string, Postcondition['verifier']> {
    const work = this.claimedWork(permit);
    if (effectContract !== undefined) {
      const capabilities = effectAdapterCapabilities(effectContract);
      if (!capabilities) throw new Error('EFFECT_CONTRACT_UNREGISTERED');
      if (work.packet.effect_contract !== effectContract)
        throw new Error('EFFECT_CONTRACT_NOT_AUTHORIZED');
      if (work.postcondition.verifier !== capabilities.postcondition_verifier)
        throw new Error('EFFECT_POSTCONDITION_MISMATCH');
    }
    const authorityContract =
      effectContract ??
      (typeof work.packet.effect_contract === 'string'
        ? work.packet.effect_contract
        : 'overcenter/execution-effect');
    const authority = Object.freeze({
      [effectAuthorityBrand]: authorityContract,
      postcondition: Object.freeze(work.postcondition),
    }) as E extends RegisteredEffectContract
      ? EffectAuthority<E, EffectVerifier<Extract<E, RegisteredEffectContract>>>
      : EffectAuthority<string, Postcondition['verifier']>;
    effectAuthorityPermits.set(authority, permit);
    return authority;
  }

  deriveReadyWork(): Work | null {
    const head = this.#requireHead();
    return this.#currentProjection(head).project.readyWork;
  }

  explain(id: string): ProjectExplanation {
    const head = this.#requireHead();
    return explainProjectWork(this.#currentProjection(head).project, id);
  }

  claim(
    id: string,
    expectedRevision: string,
    { sourceRevision }: ClaimOptions = {},
  ): ExecutionPermit {
    const head = this.#requireHead();
    if (head !== expectedRevision) throw new Error('STALE_REVISION');
    const { state, project } = this.#currentProjection(head);
    const work = state.obligations[id];
    if (!work) throw new Error(`unknown obligation: ${id}`);
    const claimError = project.claimabilityErrors.get(id);
    if (claimError) throw new Error(claimError);
    const key = project.semanticKeys.get(id);
    if (!key) throw new Error('SEMANTIC_DEPENDENCY_UNRESOLVED');

    const runId = randomUUID();
    const executionCapability = randomUUID();
    const executionCapabilitySha256 = this.#capabilityDigest(executionCapability);
    const claim: ClaimFact = {
      schema: CLAIM_SCHEMA,
      run_id: runId,
      obligation_id: id,
      claimed_revision: head,
      obligation_key: key,
      execution_capability_sha256: executionCapabilitySha256,
    };
    let sourceBinding: SourceRevisionBindingFact | null = null;
    if (sourceRevision !== undefined) {
      const normalized = sourceRevision.toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error('SOURCE_REVISION_INVALID');
      sourceBinding = {
        schema: SOURCE_REVISION_BINDING_SCHEMA,
        run_id: runId,
        obligation_id: id,
        source_revision: normalized,
      };
    }
    const commit = this.#store.append(head, `overcenter: claim ${id} ${runId}`, {
      'claim.json': claim,
      ...(sourceBinding ? { 'source-revision.json': sourceBinding } : {}),
    });
    if (!commit) throw new Error('CLAIM_LOST');
    return {
      id: runId,
      obligation_id: id,
      claimed_revision: head,
      claim_commit: commit,
      obligation_key: key,
      execution_generation: 1,
      execution_authority_commit: commit,
      execution_capability_sha256: executionCapabilitySha256,
      execution_capability: executionCapability,
      ...(sourceBinding ? { source_revision: sourceBinding.source_revision } : {}),
    };
  }

  claimedSourceRevision(runId: string): string | null {
    const run = this.#historicalProjection(this.#requireHead()).history.runs.get(runId);
    if (!run) throw new Error('UNKNOWN_RUN');
    return run.source_revision ?? null;
  }

  sourceClaimBinding(runId: string): SourceClaimBinding {
    const run = this.#historicalProjection(this.#requireHead()).history.runs.get(runId);
    if (!run) throw new Error('UNKNOWN_RUN');
    if (!run.source_revision) throw new Error('SOURCE_REVISION_MISSING');
    return bindSourceClaim(run.obligation_key, run.id, run.claimed_revision, run.source_revision);
  }

  acquireExecution(runId: string): ExecutionPermit {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#requireHead();
      const { history, project } = this.#historicalProjection(head);
      const run = history.runs.get(runId);
      if (!run) throw new Error('UNKNOWN_RUN');
      const prior = history.receiptsByRun.get(runId);
      if (prior && ['DONE', 'READY'].includes(prior.disposition)) {
        throw new Error('RUN_ALREADY_TERMINAL');
      }
      const lifecycle = project.lifecycles.get(run.obligation_id);
      if (
        lifecycle?.run?.id !== runId ||
        !['EXECUTING', 'RECOVERY_REQUIRED', 'WAITING'].includes(lifecycle.status)
      ) {
        throw new Error('AUTHORITY_LOST');
      }

      const executionCapability = randomUUID();
      const executionCapabilitySha256 = this.#capabilityDigest(executionCapability);
      const fact: ExecutionAuthorityFact = {
        schema: EXECUTION_AUTHORITY_SCHEMA,
        run_id: run.id,
        obligation_id: run.obligation_id,
        generation: run.execution_generation + 1,
        previous_authority_commit: run.execution_authority_commit,
        execution_capability_sha256: executionCapabilitySha256,
      };
      const commit = this.#store.append(
        head,
        `overcenter: acquire execution ${run.obligation_id} ${run.id} g${fact.generation}`,
        { 'execution-authority.json': fact },
      );
      if (!commit) continue;
      return {
        ...run,
        execution_generation: fact.generation,
        execution_authority_commit: commit,
        execution_capability_sha256: executionCapabilitySha256,
        execution_capability: executionCapability,
      };
    }
    throw new Error('EXECUTION_AUTHORITY_CONTENTION_EXHAUSTED');
  }

  beginEffect(permit: ExecutionPermit): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#requireHead();
      const { history, project } = this.#historicalProjection(head);
      const run = history.runs.get(permit.id);
      if (!run) throw new Error('UNKNOWN_RUN');
      const authority = projectExecutionAuthority(
        run,
        permit,
        this.#capabilityDigest(permit.execution_capability),
      );
      if (!authority.current_authority || !authority.exact_revision) {
        throw new Error('STALE_EXECUTION_GENERATION');
      }
      const lifecycle = project.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id !== run.id || lifecycle.status !== 'EXECUTING') {
        throw new Error('RUN_NOT_EXECUTING');
      }
      if (
        !mutationAdmitted({
          ...authority,
          unresolved_effect: history.unresolvedReservationsByRun.has(run.id),
        })
      )
        throw new Error('UNRESOLVED_EFFECT');

      const fact: EffectReservationFact = {
        schema: EFFECT_RESERVATION_SCHEMA,
        run_id: run.id,
        obligation_id: run.obligation_id,
        execution_generation: run.execution_generation,
        execution_authority_commit: run.execution_authority_commit,
      };
      const commit = this.#store.append(
        head,
        `overcenter: reserve effect ${run.obligation_id} ${run.id} g${run.execution_generation}`,
        { 'effect-reservation.json': fact },
      );
      if (commit) return commit;
    }
    throw new Error('EFFECT_RESERVATION_CONTENTION_EXHAUSTED');
  }

  async performEffect<T, E extends string, V extends Postcondition['verifier']>(
    authority: EffectAuthority<E, V>,
    effect: (attempt: EffectAttemptBinding) => Promise<T> | T,
  ): Promise<T> {
    const permit = effectAuthorityPermit(authority);
    const reservationCommit = this.beginEffect(permit);
    const attempt: EffectAttemptBinding = Object.freeze({
      run_id: permit.id,
      obligation_id: permit.obligation_id,
      execution_generation: permit.execution_generation,
      execution_authority_commit: permit.execution_authority_commit,
      reservation_commit: reservationCommit,
      effect_contract: authority[effectAuthorityBrand],
    });
    return await effect(attempt);
  }

  releaseEffectReservation<E extends string, V extends Postcondition['verifier']>(
    authority: EffectAuthority<E, V>,
    witness: TrustedEffectReleaseWitness,
    diagnostic: Data = {},
  ): Receipt {
    const permit = effectAuthorityPermit(authority);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#requireHead();
      const { history, project } = this.#historicalProjection(head);
      const run = history.runs.get(permit.id);
      if (!run) throw new Error('UNKNOWN_RUN');
      const projectedAuthority = projectExecutionAuthority(
        run,
        permit,
        this.#capabilityDigest(permit.execution_capability),
      );
      if (!projectedAuthority.current_authority || !projectedAuthority.exact_revision) {
        throw new Error('STALE_EXECUTION_GENERATION');
      }
      const lifecycle = project.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id !== run.id || lifecycle.status !== 'EXECUTING') {
        throw new Error('RUN_NOT_EXECUTING');
      }
      const reservation = history.unresolvedReservationsByRun.get(run.id);
      if (!reservation) throw new Error('NO_UNRESOLVED_EFFECT');
      const effectContract = authority[effectAuthorityBrand];
      const validatedWitness = validateTrustedEffectReleaseWitness(witness);
      const binding = validatedWitness.attempt;
      if (
        binding.run_id !== run.id ||
        binding.obligation_id !== run.obligation_id ||
        binding.execution_generation !== run.execution_generation ||
        binding.execution_authority_commit !== run.execution_authority_commit ||
        binding.reservation_commit !== reservation.reservation_commit ||
        binding.effect_contract !== effectContract
      ) {
        throw new Error('EFFECT_RELEASE_EVIDENCE_BINDING_MISMATCH');
      }
      if (!reservedEffectReleaseWitnessSafe(run.obligation, effectContract, validatedWitness)) {
        throw new Error('EFFECT_RELEASE_EVIDENCE_NOT_AUTHORIZED');
      }

      const evidence = retainEffectReleaseEvidence(validatedWitness);
      const release: EffectReleaseFact = {
        schema: EFFECT_RELEASE_SCHEMA,
        schema_version: EFFECT_RELEASE_SCHEMA_VERSION,
        run_id: run.id,
        obligation_id: run.obligation_id,
        execution_generation: run.execution_generation,
        execution_authority_commit: run.execution_authority_commit,
        reservation_commit: reservation.reservation_commit,
        effect_contract: effectContract,
        evidence_kind: validatedWitness.kind,
        evidence,
        evidence_ref: effectReleaseEvidenceRef(evidence),
      };
      const receiptFact = this.#receiptFact(
        run,
        run.obligation_id,
        'effect-not-dispatched',
        null,
        diagnostic,
      );
      const commit = this.#store.append(
        head,
        `overcenter: release undispatched effect ${run.obligation_id} ${run.id}`,
        {
          'effect-release.json': release,
          'receipt.json': receiptFact,
        },
      );
      if (!commit) continue;
      const receipt = this.#historicalProjection(commit).history.receiptsByRun.get(run.id);
      if (!receipt || receipt.disposition !== 'READY') {
        throw new Error('EFFECT_RELEASE_PROJECTION_FAILED');
      }
      return receipt;
    }
    throw new Error('EFFECT_RELEASE_CONTENTION_EXHAUSTED');
  }

  settleSourceIntegration(
    permit: ExecutionPermit,
    witness: TrustedSourceIntegrationWitness,
  ): Receipt {
    const evidence = trustedSourceIntegrationEvidence(witness);
    const receipt = this.#settleWithoutObservation(
      permit,
      'source-integration',
      { source_integration: evidence },
      ({ run, work }) => {
        if (
          work.packet.kind !== 'source-change' ||
          work.postcondition.verifier !== 'source-integration/v1'
        ) {
          throw new Error('SOURCE_SETTLEMENT_WORK_INVALID');
        }
        if (
          evidence.run_id !== run.id ||
          evidence.obligation_key !== run.obligation_key ||
          evidence.source_sha !== run.source_revision
        ) {
          throw new Error('SOURCE_INTEGRATION_EVIDENCE_BINDING_MISMATCH');
        }
      },
    );
    if (receipt.disposition !== 'DONE' || !receipt.verified) {
      throw new Error('SOURCE_INTEGRATION_PROJECTION_FAILED');
    }
    return receipt;
  }

  retrySourceIntegration(permit: ExecutionPermit, reason: string, diagnostic: Data = {}): Receipt {
    if (!reason) throw new Error('SOURCE_RETRY_REASON_INVALID');
    const receipt = this.#settleWithoutObservation(
      permit,
      'source-retry',
      {
        ...structuredClone(diagnostic),
        source_retry: { reason },
      },
      ({ work }) => {
        if (
          work.packet.kind !== 'source-change' ||
          work.postcondition.verifier !== 'source-integration/v1'
        ) {
          throw new Error('SOURCE_RETRY_WORK_INVALID');
        }
      },
    );
    if (receipt.disposition !== 'READY') {
      throw new Error('SOURCE_RETRY_PROJECTION_FAILED');
    }
    return receipt;
  }

  resolve(permit: ExecutionPermit, diagnostic: Data = {}): Receipt {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.#resolutionCandidate(permit);
      if ('receipt' in candidate) return candidate.receipt;
      const settled = this.#commitObservation(
        candidate,
        this.#observe(candidate.work.postcondition),
        diagnostic,
      );
      if (settled) return settled;
    }
    throw new Error('RESOLVE_CONTENTION_EXHAUSTED');
  }

  async resolveAsync(permit: ExecutionPermit, diagnostic: Data = {}): Promise<Receipt> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.#resolutionCandidate(permit);
      if ('receipt' in candidate) return candidate.receipt;
      const settled = this.#commitObservation(
        candidate,
        await this.#observeAsync(candidate.work.postcondition),
        diagnostic,
      );
      if (settled) return settled;
    }
    throw new Error('RESOLVE_CONTENTION_EXHAUSTED');
  }

  deferForJudgment(permit: ExecutionPermit, diagnostic: Data = {}): Receipt {
    return this.#settleWithoutObservation(permit, 'judgment-required', diagnostic);
  }

  recoverInterrupted(permit: ExecutionPermit, diagnostic: Data = {}): Receipt {
    return this.#settleWithoutObservation(permit, 'execution-terminated', diagnostic);
  }

  reconcile(permit: ExecutionPermit): Receipt {
    return this.resolve(permit);
  }

  receipts(runId: string | null = null): Receipt[] {
    const head = this.#requireHead();
    const { history } = this.#historicalProjection(head);
    return runId
      ? history.receipts.filter((receipt) => receipt.run_id === runId)
      : history.receipts;
  }

  hasUnresolvedEffect(runId: string): boolean {
    const head = this.#requireHead();
    return this.#historicalProjection(head).history.unresolvedReservationsByRun.has(runId);
  }

  #commitGraphPatch(
    projection: Projection,
    upsert: Obligation[],
    retire: string[],
    head: string,
  ): string {
    const { state, project, definitions } = projection;
    if (hasInFlight(project)) throw new Error('PROJECT_BUSY');

    const planned = upsert
      .map((obligation) => structuredClone(obligation))
      .sort((a, b) => a.id.localeCompare(b.id));
    const retiring = [...retire].sort((a, b) => a.localeCompare(b));

    const seen = new Set<string>();
    for (const obligation of planned) {
      if (seen.has(obligation.id)) {
        throw new Error(`DUPLICATE_GRAPH_PATCH_ID:${obligation.id}`);
      }
      seen.add(obligation.id);
    }
    for (const id of retiring) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('INVALID_OBLIGATION_ID');
      }
      if (seen.has(id)) throw new Error(`DUPLICATE_GRAPH_PATCH_ID:${id}`);
      seen.add(id);
    }

    const next = {
      obligations: structuredClone(state.obligations),
      definition_ids: { ...state.definition_ids },
    };
    const newDefinitions: GraphPatchFact['definitions'] = [];
    const bindings: GraphPatchFact['bindings'] = [];
    const introducedDefinitions = new Set<string>();

    for (const obligation of planned) {
      const definition = obligationDefinition(obligation);
      const definitionId = obligationDefinitionId(definition);
      if (state.definition_ids[obligation.id] === definitionId) continue;

      if (!definitions[definitionId] && !introducedDefinitions.has(definitionId)) {
        newDefinitions.push({ id: definitionId, definition });
        introducedDefinitions.add(definitionId);
      }
      bindings.push({
        node_id: obligation.id,
        definition_id: definitionId,
      });
      next.obligations[obligation.id] = materializeObligation(obligation.id, definition);
      next.definition_ids[obligation.id] = definitionId;
    }

    for (const id of retiring) {
      if (!state.obligations[id]) throw new Error(`unknown obligation: ${id}`);
      delete next.obligations[id];
      delete next.definition_ids[id];
    }

    if (bindings.length === 0 && retiring.length === 0) {
      throw new Error('NOOP_GRAPH_PATCH');
    }

    validateAdmission(next);
    const fact: GraphPatchFact = {
      schema: GRAPH_PATCH_SCHEMA,
      definitions: newDefinitions,
      bindings,
      retire: retiring,
    };
    const added = bindings.filter(({ node_id }) => !state.obligations[node_id]).length;
    const rebound = bindings.length - added;
    const commit = this.#store.append(
      head,
      `overcenter: patch graph +${added} ~${rebound} -${retiring.length}`,
      { 'graph-patch.json': fact },
    );
    if (!commit) throw new Error('GRAPH_PATCH_LOST');
    return commit;
  }

  #resolutionCandidate(permit: ExecutionPermit):
    | { receipt: Receipt }
    | {
        head: string;
        run: HistoricalRun;
        work: HistoricalRun['obligation'];
        unresolvedEffect: boolean;
      } {
    const runId = permit.id;
    const head = this.#requireHead();
    const { state, history, project } = this.#historicalProjection(head);
    const known = history.runs.get(runId);
    if (!known) throw new Error('UNKNOWN_RUN');
    const prior = history.receiptsByRun.get(runId);
    if (prior && ['DONE', 'READY'].includes(prior.disposition)) {
      return { receipt: prior };
    }
    if (!state.obligations[known.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
    const work = known.obligation;
    const run = this.#requireExecutionPermit(history, permit);
    const lifecycle = project.lifecycles.get(run.obligation_id);
    if (lifecycle?.run?.id !== runId) {
      if (prior) return { receipt: prior };
      throw new Error('AUTHORITY_LOST');
    }
    if (!['EXECUTING', 'RECOVERY_REQUIRED', 'WAITING'].includes(lifecycle.status)) {
      if (prior) return { receipt: prior };
      throw new Error('NOT_RESOLVABLE');
    }
    return {
      head,
      run,
      work,
      unresolvedEffect: history.unresolvedReservationsByRun.has(runId),
    };
  }

  #commitObservation(
    candidate: {
      head: string;
      run: HistoricalRun;
      work: HistoricalRun['obligation'];
      unresolvedEffect: boolean;
    },
    observed: Observation,
    diagnostic: Data,
  ): Receipt | null {
    const { head, run, work, unresolvedEffect } = candidate;
    const fact = this.#receiptFact(run, work.id, 'observation', observed, diagnostic);
    const receipt = projectReceipt(fact, work, undefined, unresolvedEffect);
    const commit = this.#store.append(head, `overcenter: observe ${work.id} ${run.id}`, {
      'receipt.json': fact,
    });
    return commit ? { ...receipt, settlement_commit: commit } : null;
  }

  #settleWithoutObservation(
    permit: ExecutionPermit,
    kind: Extract<
      ReceiptKind,
      'judgment-required' | 'execution-terminated' | 'source-integration' | 'source-retry'
    >,
    diagnostic: Data,
    validate?: (context: { run: HistoricalRun; work: HistoricalRun['obligation'] }) => void,
  ): Receipt {
    const runId = permit.id;
    const policy =
      kind === 'judgment-required'
        ? {
            action: 'judgment required',
            lifecycleError: 'AUTHORITY_LOST',
            unresolvedError: 'UNRESOLVED_EFFECT',
            contentionError: 'DEFER_CONTENTION_EXHAUSTED',
          }
        : kind === 'execution-terminated'
          ? {
              action: 'execution terminated',
              lifecycleError: 'RUN_NOT_EXECUTING',
              unresolvedError: null,
              contentionError: 'RECOVERY_CONTENTION_EXHAUSTED',
            }
          : kind === 'source-integration'
            ? {
                action: 'integrate source',
                lifecycleError: 'SOURCE_SETTLEMENT_RUN_NOT_EXECUTING',
                unresolvedError: 'SOURCE_SETTLEMENT_WITH_UNRESOLVED_EFFECT',
                contentionError: 'SOURCE_INTEGRATION_SETTLEMENT_CONTENTION_EXHAUSTED',
              }
            : {
                action: 'retry source',
                lifecycleError: 'SOURCE_RETRY_RUN_NOT_EXECUTING',
                unresolvedError: 'SOURCE_RETRY_WITH_UNRESOLVED_EFFECT',
                contentionError: 'SOURCE_RETRY_CONTENTION_EXHAUSTED',
              };

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#requireHead();
      const { state, history, project } = this.#historicalProjection(head);
      const known = history.runs.get(runId);
      if (!known) throw new Error('UNKNOWN_RUN');
      const prior = history.receiptsByRun.get(runId);
      if (prior && ['DONE', 'READY'].includes(prior.disposition)) return prior;
      if (!state.obligations[known.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');

      const work = known.obligation;
      const run = this.#requireExecutionPermit(history, permit);
      const lifecycle = project.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id !== runId || lifecycle.status !== 'EXECUTING') {
        if (prior) return prior;
        throw new Error(policy.lifecycleError);
      }
      if (policy.unresolvedError && history.unresolvedReservationsByRun.has(runId)) {
        throw new Error(policy.unresolvedError);
      }
      validate?.({ run, work });

      const fact = this.#receiptFact(run, work.id, kind, null, diagnostic);
      const receipt = projectReceipt(fact, work);
      const commit = this.#store.append(head, `overcenter: ${policy.action} ${work.id} ${runId}`, {
        'receipt.json': fact,
      });
      if (commit) return { ...receipt, settlement_commit: commit };
    }
    throw new Error(policy.contentionError);
  }

  #requireHead(): string {
    const head = this.head();
    if (!head) throw new Error('NOT_INITIALIZED');
    return head;
  }

  #historicalProjection(head: string): Projection {
    const commits = this.#store.history(head);
    const cached = this.#projectionCache;
    let projection: Projection;

    if (
      cached &&
      cached.commitCount > 0 &&
      cached.commitCount <= commits.length &&
      commits[cached.commitCount - 1]?.commit === cached.head
    ) {
      projection = cached.projection;
      for (const record of commits.slice(cached.commitCount)) {
        projection = advanceProjection(projection, record);
      }
    } else {
      projection = replayProjection(commits);
    }

    this.#projectionCache = { head, commitCount: commits.length, projection };
    return projection;
  }

  #currentProjection(head: string): Projection {
    const historical = this.#historicalProjection(head);
    const currentRealizationJudgments = deriveCurrentRealizationJudgments({
      state: historical.state,
      runs: historical.history.runs,
      receiptsByRun: historical.history.receiptsByRun,
      semanticKeys: historical.project.semanticKeys,
      observe: (postcondition) => this.#observe(postcondition),
    });
    const project = deriveProjectProjection({
      state: historical.state,
      runs: historical.history.runs,
      receiptsByRun: historical.history.receiptsByRun,
      revision: head,
      currentBindingOrdinals: historical.history.currentBindingOrdinals,
      claimOrdinalsByRun: historical.history.claimOrdinalsByRun,
      currentRealizationJudgments,
    });
    return {
      ...historical,
      project,
    };
  }

  #observe(postcondition: Postcondition): Observation {
    return observePostcondition(postcondition, this.observationContext);
  }

  async #observeAsync(postcondition: Postcondition): Promise<Observation> {
    return await observePostconditionAsync(postcondition, this.observationContext);
  }

  #capabilityDigest(capability: string): string {
    return sha256(capability);
  }

  #requireExecutionPermit(history: Projection['history'], permit: ExecutionPermit): HistoricalRun {
    const run = history.runs.get(permit.id);
    if (!run) throw new Error('UNKNOWN_RUN');
    const authority = projectExecutionAuthority(
      run,
      permit,
      this.#capabilityDigest(permit.execution_capability),
    );
    if (!authority.current_authority || !authority.exact_revision) {
      throw new Error('STALE_EXECUTION_GENERATION');
    }
    return run;
  }

  #receiptFact(
    run: Run,
    obligationId: string,
    kind: ReceiptKind,
    observed: Observation | null,
    diagnostic?: Data,
  ): ReceiptFact {
    return {
      schema: RECEIPT_SCHEMA,
      run_id: run.id,
      obligation_id: obligationId,
      claimed_revision: run.claimed_revision,
      claim_commit: run.claim_commit,
      execution_generation: run.execution_generation,
      execution_authority_commit: run.execution_authority_commit,
      kind,
      observed,
      ...(diagnostic ? { diagnostic } : {}),
      settled_at: new Date().toISOString(),
    };
  }
}

export { runCoreLoop } from '../execution/core-loop.ts';
