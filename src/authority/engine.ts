import { createHash, randomUUID } from 'node:crypto';
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
  DELEGATION_DISCHARGE_SCHEMA,
  DELEGATION_RESERVATION_SCHEMA,
  DELEGATION_SCHEMA_VERSION,
  EFFECT_RELEASE_SCHEMA,
  EFFECT_RELEASE_SCHEMA_VERSION,
  EFFECT_RESERVATION_SCHEMA,
  EXECUTION_AUTHORITY_SCHEMA,
  GRAPH_PATCH_SCHEMA,
  RECEIPT_SCHEMA,
  materializeObligation,
  normalizeObligation,
  obligationDefinition,
  obligationDefinitionId,
} from './facts.ts';
import type {
  ClaimFact,
  DelegationDischargeFact,
  DelegationReservationFact,
  EffectReleaseFact,
  EffectReservationFact,
  ExecutionAuthorityFact,
  GraphPatchFact,
  HistoricalRun,
  ObligationInput,
  Receipt,
  ReceiptFact,
  ReceiptKind,
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
import {
  delegationReservationAuthorityError,
  mutationAdmitted,
  projectExecutionAuthority,
} from './transaction-admission.ts';
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
import { delegationCreatesCausalCycle } from './delegation.ts';

export type { Receipt } from './facts.ts';

export interface KernelOptions {
  githubToken?: string | null;
  observationContext?: Omit<ObservationContext, 'githubToken'>;
}

const effectAuthorityBrand: unique symbol = Symbol('effect-authority');
export type EffectAuthority<E extends string, V extends Postcondition['verifier']> = {
  readonly [effectAuthorityBrand]: E;
  readonly permit: ExecutionPermit;
  readonly postcondition: Extract<Postcondition, { verifier: V }>;
};

const spawnAuthorityBrand: unique symbol = Symbol('spawn-authority');
export type SpawnAuthority = {
  readonly [spawnAuthorityBrand]: true;
  readonly permit: ExecutionPermit;
};

export interface DelegationAttemptBinding {
  delegation_id: string;
  run_id: string;
  obligation_id: string;
  execution_generation: number;
  execution_authority_commit: string;
  reservation_commit: string;
  child_obligation_id: string;
}

export interface GraphPatchInput {
  upsert?: ObligationInput[];
  retire?: string[];
}

export interface GraphReconciliationResult {
  revision: string;
  added: string[];
  rebound: string[];
  unchanged: string[];
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

  reconcileGraph(desired: ObligationInput[], expectedRevision: string): GraphReconciliationResult {
    const head = this.#requireHead();
    if (head !== expectedRevision) throw new Error('STALE_REVISION');

    const projection = this.#historicalProjection(head);
    const plan = planGraphReconciliation(projection.state, desired);
    if (plan.upsert.length === 0) {
      return {
        revision: head,
        added: [],
        rebound: [],
        unchanged: plan.unchanged,
      };
    }

    const revision = this.#commitGraphPatch(projection, plan.upsert, [], head);
    return {
      revision,
      added: plan.added,
      rebound: plan.rebound,
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

  authorizeEffect<E extends RegisteredEffectContract>(
    permit: ExecutionPermit,
    effectContract: E,
  ): EffectAuthority<E, EffectVerifier<E>> {
    const work = this.claimedWork(permit);
    const capabilities = effectAdapterCapabilities(effectContract)!;
    if (work.packet.effect_contract !== effectContract)
      throw new Error('EFFECT_CONTRACT_NOT_AUTHORIZED');
    if (work.postcondition.verifier !== capabilities.postcondition_verifier)
      throw new Error('EFFECT_POSTCONDITION_MISMATCH');
    return {
      [effectAuthorityBrand]: effectContract,
      permit,
      postcondition: work.postcondition as EffectAuthority<E, EffectVerifier<E>>['postcondition'],
    };
  }

  authorizeSpawn(permit: ExecutionPermit): SpawnAuthority {
    const head = this.#requireHead();
    const { history, project } = this.#historicalProjection(head);
    const run = this.#requireExecutionPermit(history, permit);
    const lifecycle = project.lifecycles.get(run.obligation_id);
    if (lifecycle?.run?.id !== run.id || lifecycle.status !== 'EXECUTING') {
      throw new Error('RUN_NOT_EXECUTING');
    }
    return {
      [spawnAuthorityBrand]: true,
      permit,
    };
  }

  deriveReadyWork(): Work | null {
    const head = this.#requireHead();
    return this.#currentProjection(head).project.readyWork;
  }

  explain(id: string): ProjectExplanation {
    const head = this.#requireHead();
    return explainProjectWork(this.#currentProjection(head).project, id);
  }

  claim(id: string, expectedRevision: string): ExecutionPermit {
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
    const commit = this.#store.append(head, `overcenter: claim ${id} ${runId}`, {
      'claim.json': claim,
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
    };
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
    const reservationCommit = this.beginEffect(authority.permit);
    const attempt: EffectAttemptBinding = Object.freeze({
      run_id: authority.permit.id,
      obligation_id: authority.permit.obligation_id,
      execution_generation: authority.permit.execution_generation,
      execution_authority_commit: authority.permit.execution_authority_commit,
      reservation_commit: reservationCommit,
      effect_contract: authority[effectAuthorityBrand],
    });
    return await effect(attempt);
  }

  #reserveDelegation(
    authority: SpawnAuthority,
    childObligationId: string,
  ): DelegationAttemptBinding {
    if (authority[spawnAuthorityBrand] !== true) throw new Error('SPAWN_AUTHORITY_INVALID');
    if (typeof childObligationId !== 'string' || childObligationId.length === 0) {
      throw new Error('INVALID_CHILD_OBLIGATION_ID');
    }

    const delegationId = randomUUID();
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#requireHead();
      const { state, history, project } = this.#historicalProjection(head);
      const run = this.#requireExecutionPermit(history, authority.permit);
      const lifecycle = project.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id !== run.id || lifecycle.status !== 'EXECUTING') {
        throw new Error('RUN_NOT_EXECUTING');
      }
      if (!state.obligations[childObligationId]) throw new Error('DELEGATION_CHILD_UNKNOWN');
      if (childObligationId === run.obligation_id) throw new Error('DELEGATION_SELF_REFERENCE');
      if (
        delegationCreatesCausalCycle({
          state,
          runs: history.runs,
          unresolvedDelegationsByRun: history.unresolvedDelegationsByRun,
          parentObligationId: run.obligation_id,
          childObligationId,
        })
      ) {
        throw new Error('DELEGATION_CAUSAL_CYCLE');
      }
      if (project.lifecycles.get(childObligationId)?.status === 'DONE') {
        throw new Error('DELEGATION_CHILD_ALREADY_DONE');
      }

      const fact: DelegationReservationFact = {
        schema: DELEGATION_RESERVATION_SCHEMA,
        schema_version: DELEGATION_SCHEMA_VERSION,
        delegation_id: delegationId,
        run_id: run.id,
        obligation_id: run.obligation_id,
        execution_generation: run.execution_generation,
        execution_authority_commit: run.execution_authority_commit,
        child_obligation_id: childObligationId,
      };
      const authorityError = delegationReservationAuthorityError(run, fact);
      if (authorityError) throw new Error(authorityError);

      const commit = this.#store.append(
        head,
        `overcenter: reserve delegation ${run.obligation_id} -> ${childObligationId} ${delegationId}`,
        { 'delegation-reservation.json': fact },
      );
      if (!commit) continue;
      return Object.freeze({
        delegation_id: delegationId,
        run_id: run.id,
        obligation_id: run.obligation_id,
        execution_generation: run.execution_generation,
        execution_authority_commit: run.execution_authority_commit,
        reservation_commit: commit,
        child_obligation_id: childObligationId,
      });
    }
    throw new Error('DELEGATION_RESERVATION_CONTENTION_EXHAUSTED');
  }

  async performDelegation<T>(
    authority: SpawnAuthority,
    childObligationId: string,
    dispatch: (attempt: DelegationAttemptBinding) => Promise<T> | T,
  ): Promise<{ binding: DelegationAttemptBinding; result: T }> {
    const binding = this.#reserveDelegation(authority, childObligationId);
    return {
      binding,
      result: await dispatch(binding),
    };
  }

  dischargeDelegation(binding: DelegationAttemptBinding): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#requireHead();
      const { history, project } = this.#historicalProjection(head);
      const delegation = history.delegationsById.get(binding.delegation_id);
      if (!delegation) throw new Error('DELEGATION_UNKNOWN');
      if (
        delegation.run_id !== binding.run_id ||
        delegation.obligation_id !== binding.obligation_id ||
        delegation.execution_generation !== binding.execution_generation ||
        delegation.execution_authority_commit !== binding.execution_authority_commit ||
        delegation.reservation_commit !== binding.reservation_commit ||
        delegation.child_obligation_id !== binding.child_obligation_id
      ) {
        throw new Error('DELEGATION_BINDING_MISMATCH');
      }
      if (delegation.discharge_commit) return delegation.discharge_commit;

      const child = project.lifecycles.get(delegation.child_obligation_id);
      if (child?.status !== 'DONE' || !child.run) {
        throw new Error('DELEGATION_CHILD_NOT_DONE');
      }
      const childReceipt = history.receiptsByRun.get(child.run.id);
      if (childReceipt?.disposition !== 'DONE' || !childReceipt.settlement_commit) {
        throw new Error('DELEGATION_CHILD_SETTLEMENT_MISSING');
      }

      const fact: DelegationDischargeFact = {
        schema: DELEGATION_DISCHARGE_SCHEMA,
        schema_version: DELEGATION_SCHEMA_VERSION,
        delegation_id: delegation.delegation_id,
        run_id: delegation.run_id,
        child_obligation_id: delegation.child_obligation_id,
        reservation_commit: delegation.reservation_commit,
        child_run_id: child.run.id,
        child_settlement_commit: childReceipt.settlement_commit,
      };
      const commit = this.#store.append(
        head,
        `overcenter: discharge delegation ${delegation.delegation_id}`,
        { 'delegation-discharge.json': fact },
      );
      if (commit) return commit;
    }
    throw new Error('DELEGATION_DISCHARGE_CONTENTION_EXHAUSTED');
  }

  releaseEffectReservation<E extends string, V extends Postcondition['verifier']>(
    authority: EffectAuthority<E, V>,
    witness: TrustedEffectReleaseWitness,
    diagnostic: Data = {},
  ): Receipt {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#requireHead();
      const { history, project } = this.#historicalProjection(head);
      const run = history.runs.get(authority.permit.id);
      if (!run) throw new Error('UNKNOWN_RUN');
      const projectedAuthority = projectExecutionAuthority(
        run,
        authority.permit,
        this.#capabilityDigest(authority.permit.execution_capability),
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
      if ((history.unresolvedDelegationsByRun.get(run.id)?.size ?? 0) > 0) {
        throw new Error('UNRESOLVED_DELEGATION');
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
    const runId = permit.id;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#requireHead();
      const { state, history, project } = this.#historicalProjection(head);
      const known = history.runs.get(runId);
      if (!known) throw new Error('UNKNOWN_RUN');
      const prior = history.receiptsByRun.get(runId);
      if (prior && ['DONE', 'READY'].includes(prior.disposition)) {
        return prior;
      }
      if (!state.obligations[known.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
      const work = known.obligation;
      const run = this.#requireExecutionPermit(history, permit);
      const lifecycle = project.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id !== runId || lifecycle.status !== 'EXECUTING') {
        if (prior) return prior;
        throw new Error('AUTHORITY_LOST');
      }
      if (history.unresolvedReservationsByRun.has(runId)) {
        throw new Error('UNRESOLVED_EFFECT');
      }

      const fact = this.#receiptFact(run, work.id, 'judgment-required', null, diagnostic);
      const receipt = projectReceipt(fact, work);
      const commit = this.#store.append(
        head,
        `overcenter: judgment required ${work.id} ${run.id}`,
        { 'receipt.json': fact },
      );
      if (commit) return { ...receipt, settlement_commit: commit };
    }
    throw new Error('DEFER_CONTENTION_EXHAUSTED');
  }

  recoverInterrupted(permit: ExecutionPermit, diagnostic: Data = {}): Receipt {
    const runId = permit.id;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#requireHead();
      const { state, history, project } = this.#historicalProjection(head);
      const known = history.runs.get(runId);
      if (!known) throw new Error('UNKNOWN_RUN');
      const prior = history.receiptsByRun.get(runId);
      if (prior && ['DONE', 'READY'].includes(prior.disposition)) {
        return prior;
      }
      if (!state.obligations[known.obligation_id]) throw new Error('UNKNOWN_OBLIGATION');
      const work = known.obligation;
      const run = this.#requireExecutionPermit(history, permit);
      const lifecycle = project.lifecycles.get(run.obligation_id);
      if (lifecycle?.run?.id !== runId || lifecycle.status !== 'EXECUTING') {
        if (prior) return prior;
        throw new Error('RUN_NOT_EXECUTING');
      }

      const fact = this.#receiptFact(run, work.id, 'execution-terminated', null, diagnostic);
      const receipt = projectReceipt(fact, work);
      const commit = this.#store.append(
        head,
        `overcenter: execution terminated ${work.id} ${runId}`,
        { 'receipt.json': fact },
      );
      if (commit) return { ...receipt, settlement_commit: commit };
    }
    throw new Error('RECOVERY_CONTENTION_EXHAUSTED');
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

  outstandingDelegations(runId: string): DelegationAttemptBinding[] {
    const head = this.#requireHead();
    const { history } = this.#historicalProjection(head);
    if (!history.runs.has(runId)) throw new Error('UNKNOWN_RUN');
    return [...(history.unresolvedDelegationsByRun.get(runId)?.values() ?? [])]
      .map((delegation) =>
        Object.freeze({
          delegation_id: delegation.delegation_id,
          run_id: delegation.run_id,
          obligation_id: delegation.obligation_id,
          execution_generation: delegation.execution_generation,
          execution_authority_commit: delegation.execution_authority_commit,
          reservation_commit: delegation.reservation_commit,
          child_obligation_id: delegation.child_obligation_id,
        }),
      )
      .sort((left, right) => left.delegation_id.localeCompare(right.delegation_id));
  }

  hasUnresolvedDelegation(runId: string): boolean {
    const head = this.#requireHead();
    return (
      (this.#historicalProjection(head).history.unresolvedDelegationsByRun.get(runId)?.size ?? 0) >
      0
    );
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
        unresolvedDelegation: boolean;
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
      unresolvedDelegation: (history.unresolvedDelegationsByRun.get(runId)?.size ?? 0) > 0,
    };
  }

  #commitObservation(
    candidate: {
      head: string;
      run: HistoricalRun;
      work: HistoricalRun['obligation'];
      unresolvedEffect: boolean;
      unresolvedDelegation: boolean;
    },
    observed: Observation,
    diagnostic: Data,
  ): Receipt | null {
    const { head, run, work, unresolvedEffect, unresolvedDelegation } = candidate;
    const fact = this.#receiptFact(run, work.id, 'observation', observed, diagnostic);
    const receipt = projectReceipt(fact, work, undefined, unresolvedEffect);
    if (unresolvedDelegation && ['DONE', 'READY'].includes(receipt.disposition)) {
      throw new Error('UNRESOLVED_DELEGATION');
    }
    const commit = this.#store.append(head, `overcenter: observe ${work.id} ${run.id}`, {
      'receipt.json': fact,
    });
    return commit ? { ...receipt, settlement_commit: commit } : null;
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
    return createHash('sha256').update(capability).digest('hex');
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
