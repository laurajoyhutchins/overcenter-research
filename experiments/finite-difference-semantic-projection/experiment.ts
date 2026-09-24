import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { Dependency, Obligation, Observation } from '../../src/model.ts';
import {
  normalizeObligation,
  RECEIPT_SCHEMA,
  type HistoricalRun,
  type Receipt,
  type State,
} from '../../src/authority/facts.ts';
import { deriveProjectProjection, type Lifecycle } from '../../src/authority/project-state.ts';
import {
  classifyCurrentRealization,
  type CurrentRealizationJudgment,
} from '../../src/authority/realization-reuse.ts';
import { obligationKey } from '../../src/graph/identity.ts';
import { buildGraphIndex, dependencyUpstreams, validateGraph } from '../../src/graph/topology.ts';

interface Fixture {
  state: State;
  runs: Map<string, HistoricalRun>;
  receipts: Map<string, Receipt>;
  judgments: Map<string, CurrentRealizationJudgment>;
  bindingOrdinals: Map<string, number>;
  claimOrdinals: Map<string, number>;
}

interface MutationMetrics {
  semantic_nodes_examined: number;
  dependency_edges_examined: number;
  history_buckets_examined: number;
  historical_runs_examined: number;
  ready_candidates_examined: number;
}

interface MutationResult {
  touched_obligations: number;
  selected_ready: string | null;
  metrics: MutationMetrics;
}

interface RunBucket {
  latest_run: HistoricalRun | null;
  latest_done_run: HistoricalRun | null;
  latest_admissible_done_run: HistoricalRun | null;
  has_indeterminate_done: boolean;
  latest_claim_ordinal: number | null;
}

interface SemanticDownstream {
  id: string;
  selector: 'verified-content' | 'settlement-receipt';
}

function zeroMetrics(): MutationMetrics {
  return {
    semantic_nodes_examined: 0,
    dependency_edges_examined: 0,
    history_buckets_examined: 0,
    historical_runs_examined: 0,
    ready_candidates_examined: 0,
  };
}

function obligation(id: string, dependencies: Dependency[] = []): Obligation {
  return normalizeObligation({
    id,
    dependencies,
    packet: { kind: 'finite-difference-semantic-projection', id },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: `/tmp/overcenter-finite-difference-semantic/${id}`,
      content: `content:${id}`,
    },
  });
}

function stateFrom(items: Obligation[]): State {
  const state: State = { obligations: {}, definition_ids: {} };
  for (const item of items) {
    state.obligations[item.id] = structuredClone(item);
    state.definition_ids[item.id] = `experimental-${item.id}`;
  }
  validateGraph(state);
  return state;
}

function control(upstream: string): Dependency {
  return { kind: 'control', upstream };
}

function semanticContent(upstream: string): Dependency {
  return {
    kind: 'semantic',
    upstream,
    consumes: { kind: 'output', selector: 'verified-content' },
  };
}

function semanticSettlement(upstream: string): Dependency {
  return {
    kind: 'semantic',
    upstream,
    consumes: { kind: 'evidence', selector: 'settlement-receipt' },
  };
}

function admissible(): CurrentRealizationJudgment {
  return { state: 'admissible', reason: 'CURRENT_POSTCONDITION_VERIFIED' };
}

function expectedSha(work: Obligation): string {
  const postcondition = work.postcondition;
  if (postcondition.verifier !== 'file-content-equals/v1') {
    throw new Error('EXPERIMENT_POSTCONDITION_UNSUPPORTED');
  }
  return createHash('sha256').update(postcondition.content).digest('hex');
}

function presentObservation(work: Obligation, valid: boolean): Observation {
  const postcondition = work.postcondition;
  if (postcondition.verifier !== 'file-content-equals/v1') {
    throw new Error('EXPERIMENT_POSTCONDITION_UNSUPPORTED');
  }
  const expected = expectedSha(work);
  return {
    verifier: 'file-content-equals/v1',
    path: postcondition.path,
    expected_sha256: expected,
    actual_sha256: valid ? expected : '0'.repeat(64),
    mutation_certainty: 'present',
  };
}

function uncertainObservation(work: Obligation): Observation {
  const postcondition = work.postcondition;
  if (postcondition.verifier !== 'file-content-equals/v1') {
    throw new Error('EXPERIMENT_POSTCONDITION_UNSUPPORTED');
  }
  return {
    verifier: 'file-content-equals/v1',
    path: postcondition.path,
    expected_sha256: expectedSha(work),
    mutation_certainty: 'uncertain',
    observation_error: 'EXPERIMENT_READBACK_UNAVAILABLE',
  };
}

function addDoneRun(
  fixture: Fixture,
  obligationId: string,
  semanticKey: string,
  settlementCommit: string,
): string {
  const ordinal = fixture.runs.size + 1;
  const runId = `run-${obligationId}-${ordinal}`;
  const claimCommit = `claim-${obligationId}-${ordinal}`;
  const run: HistoricalRun = {
    id: runId,
    obligation_id: obligationId,
    claimed_revision: `revision-${ordinal}`,
    claim_commit: claimCommit,
    obligation_key: semanticKey,
    execution_generation: 1,
    execution_authority_commit: claimCommit,
    execution_capability_sha256: 'a'.repeat(64),
    obligation: structuredClone(fixture.state.obligations[obligationId]),
    definition_id: fixture.state.definition_ids[obligationId],
  };
  const receipt: Receipt = {
    schema: RECEIPT_SCHEMA,
    run_id: runId,
    obligation_id: obligationId,
    claimed_revision: run.claimed_revision,
    claim_commit: run.claim_commit,
    execution_generation: 1,
    execution_authority_commit: run.execution_authority_commit,
    kind: 'observation',
    observed: null,
    settled_at: '2026-09-23T00:00:00.000Z',
    disposition: 'DONE',
    verified: true,
    settlement_commit: settlementCommit,
  };
  fixture.runs.set(runId, run);
  fixture.receipts.set(runId, receipt);
  fixture.judgments.set(runId, admissible());
  fixture.claimOrdinals.set(runId, fixture.bindingOrdinals.size + ordinal);
  return runId;
}

function projection(fixture: Fixture) {
  return deriveProjectProjection({
    state: fixture.state,
    runs: fixture.runs,
    receiptsByRun: fixture.receipts,
    revision: `revision-${fixture.runs.size}`,
    currentBindingOrdinals: fixture.bindingOrdinals,
    claimOrdinalsByRun: fixture.claimOrdinals,
    currentRealizationJudgments: fixture.judgments,
  });
}

function emptyFixture(state: State): Fixture {
  return {
    state,
    runs: new Map(),
    receipts: new Map(),
    judgments: new Map(),
    bindingOrdinals: new Map(
      Object.keys(state.obligations)
        .sort()
        .map((id, index) => [id, index + 1]),
    ),
    claimOrdinals: new Map(),
  };
}

function settleIds(state: State, ids: readonly string[]): Fixture {
  const fixture = emptyFixture(state);
  for (const id of ids) {
    const project = projection(fixture);
    assert.equal(project.claimabilityErrors.get(id), null, `SETTLE_NOT_READY:${id}`);
    const key = project.semanticKeys.get(id);
    assert.ok(key, `SETTLE_SEMANTIC_KEY_MISSING:${id}`);
    addDoneRun(fixture, id, key, `settlement-${id}-1`);
  }
  return fixture;
}

function classifyObservation(
  fixture: Fixture,
  obligationId: string,
  observed: Observation,
): CurrentRealizationJudgment {
  return classifyCurrentRealization(
    fixture.state.obligations[obligationId].postcondition,
    observed,
  );
}

function applyJudgmentToOracle(
  fixture: Fixture,
  obligationId: string,
  semanticKey: string,
  judgment: CurrentRealizationJudgment,
): number {
  let updated = 0;
  for (const [runId, run] of fixture.runs) {
    if (
      run.obligation_id === obligationId &&
      run.obligation_key === semanticKey &&
      fixture.receipts.get(runId)?.disposition === 'DONE'
    ) {
      fixture.judgments.set(runId, judgment);
      updated += 1;
    }
  }
  if (updated === 0) throw new Error(`OBSERVATION_WITHOUT_DONE_REALIZATION:${obligationId}`);
  return updated;
}

class IndexedReadyHeap {
  readonly #compare: (left: string, right: string) => number;
  readonly #items: string[] = [];
  readonly #positions = new Map<string, number>();
  #comparisons = 0;

  constructor(compare: (left: string, right: string) => number) {
    this.#compare = compare;
  }

  has(id: string): boolean {
    return this.#positions.has(id);
  }

  peek(): string | null {
    return this.#items[0] ?? null;
  }

  takeComparisons(): number {
    const comparisons = this.#comparisons;
    this.#comparisons = 0;
    return comparisons;
  }

  add(id: string): void {
    if (this.has(id)) return;
    const position = this.#items.length;
    this.#items.push(id);
    this.#positions.set(id, position);
    this.#up(position);
  }

  remove(id: string): void {
    const position = this.#positions.get(id);
    if (position === undefined) return;
    const last = this.#items.pop()!;
    this.#positions.delete(id);
    if (position === this.#items.length) return;
    this.#items[position] = last;
    this.#positions.set(last, position);
    this.#repair(position);
  }

  #less(left: number, right: number): boolean {
    this.#comparisons += 1;
    return this.#compare(this.#items[left], this.#items[right]) < 0;
  }

  #swap(left: number, right: number): void {
    const a = this.#items[left];
    const b = this.#items[right];
    this.#items[left] = b;
    this.#items[right] = a;
    this.#positions.set(a, right);
    this.#positions.set(b, left);
  }

  #up(start: number): number {
    let position = start;
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (!this.#less(position, parent)) break;
      this.#swap(position, parent);
      position = parent;
    }
    return position;
  }

  #down(start: number): void {
    let position = start;
    for (;;) {
      const left = position * 2 + 1;
      const right = left + 1;
      let best = position;
      if (left < this.#items.length && this.#less(left, best)) best = left;
      if (right < this.#items.length && this.#less(right, best)) best = right;
      if (best === position) return;
      this.#swap(position, best);
      position = best;
    }
  }

  #repair(position: number): void {
    const raised = this.#up(position);
    this.#down(raised);
  }
}

class IncrementalSemanticProjection {
  readonly #fixture: Fixture;
  readonly #semanticKeys = new Map<string, string | null>();
  readonly #lifecycles = new Map<string, Lifecycle>();
  readonly #indeterminate = new Map<string, boolean>();
  readonly #claimability = new Map<string, string | null>();
  readonly #ready = new Set<string>();
  readonly #runBuckets = new Map<string, Map<string, RunBucket>>();
  readonly #semanticDownstreams = new Map<string, SemanticDownstream[]>();
  readonly #allDownstreams: ReadonlyMap<string, readonly string[]>;
  readonly #readyHeap: IndexedReadyHeap;

  constructor(fixture: Fixture) {
    this.#fixture = fixture;
    const graph = buildGraphIndex(fixture.state);
    this.#allDownstreams = graph.downstreams;
    this.#readyHeap = new IndexedReadyHeap((left, right) => {
      return this.#serviceAge(left) - this.#serviceAge(right) || left.localeCompare(right);
    });

    for (const id of Object.keys(fixture.state.obligations)) {
      this.#runBuckets.set(id, new Map());
      this.#semanticDownstreams.set(id, []);
    }
    for (const [runId] of fixture.runs) this.#indexRun(runId);
    for (const work of Object.values(fixture.state.obligations)) {
      for (const edge of work.dependencies) {
        if (edge.kind !== 'semantic') continue;
        const selector =
          edge.consumes.kind === 'output' && edge.consumes.selector === 'verified-content'
            ? 'verified-content'
            : edge.consumes.kind === 'evidence' && edge.consumes.selector === 'settlement-receipt'
              ? 'settlement-receipt'
              : null;
        if (!selector) throw new Error(`EXPERIMENT_SEMANTIC_SELECTOR_UNSUPPORTED:${work.id}`);
        this.#semanticDownstreams.get(edge.upstream)!.push({ id: work.id, selector });
      }
    }

    for (const id of graph.topologicalOrder) this.#recomputeNode(id);
    for (const id of graph.topologicalOrder) this.#refreshClaimability(id);
    this.#readyHeap.takeComparisons();
  }

  semanticKey(id: string): string | null {
    return this.#semanticKeys.get(id) ?? null;
  }

  lifecycle(id: string): Lifecycle {
    return this.#lifecycles.get(id) ?? { status: 'UNREALIZED' };
  }

  claimability(id: string): string | null {
    return this.#claimability.get(id) ?? null;
  }

  readyIds(): Set<string> {
    return new Set(this.#ready);
  }

  selectedReady(): string | null {
    return this.#readyHeap.peek();
  }

  setCurrentRealization(
    obligationId: string,
    judgment: CurrentRealizationJudgment,
  ): MutationResult {
    const key = this.semanticKey(obligationId);
    if (!key) throw new Error(`OBSERVATION_WITHOUT_SEMANTIC_KEY:${obligationId}`);
    this.#applyCurrentJudgment(obligationId, key, judgment);
    return this.#propagate(obligationId);
  }

  setCurrentRealizationLocallyOnly(
    obligationId: string,
    judgment: CurrentRealizationJudgment,
  ): void {
    const key = this.semanticKey(obligationId);
    if (!key) throw new Error(`OBSERVATION_WITHOUT_SEMANTIC_KEY:${obligationId}`);
    this.#applyCurrentJudgment(obligationId, key, judgment);
    this.#recomputeNode(obligationId);
    this.#refreshClaimability(obligationId);
  }

  addDoneRealization(obligationId: string, settlementCommit: string): MutationResult {
    const key = this.semanticKey(obligationId);
    if (!key) throw new Error(`REALIZATION_WITHOUT_SEMANTIC_KEY:${obligationId}`);
    const runId = addDoneRun(this.#fixture, obligationId, key, settlementCommit);
    this.#indexRun(runId);
    return this.#propagate(obligationId);
  }

  #bucket(obligationId: string, semanticKey: string): RunBucket | undefined {
    return this.#runBuckets.get(obligationId)?.get(semanticKey);
  }

  #ensureBucket(obligationId: string, semanticKey: string): RunBucket {
    const byKey = this.#runBuckets.get(obligationId);
    if (!byKey) throw new Error(`UNKNOWN_OBLIGATION:${obligationId}`);
    let bucket = byKey.get(semanticKey);
    if (!bucket) {
      bucket = {
        latest_run: null,
        latest_done_run: null,
        latest_admissible_done_run: null,
        has_indeterminate_done: false,
        latest_claim_ordinal: null,
      };
      byKey.set(semanticKey, bucket);
    }
    return bucket;
  }

  #indexRun(runId: string): void {
    const run = this.#fixture.runs.get(runId);
    if (!run) throw new Error(`RUN_MISSING:${runId}`);
    const bucket = this.#ensureBucket(run.obligation_id, run.obligation_key);
    bucket.latest_run = run;
    const claimOrdinal = this.#fixture.claimOrdinals.get(runId);
    if (claimOrdinal === undefined) throw new Error(`CLAIM_ORDINAL_MISSING:${runId}`);
    bucket.latest_claim_ordinal = claimOrdinal;

    if (this.#fixture.receipts.get(runId)?.disposition !== 'DONE') return;
    bucket.latest_done_run = run;
    const judgment = this.#fixture.judgments.get(runId) ?? {
      state: 'indeterminate' as const,
      reason: 'CURRENT_REALIZATION_JUDGMENT_MISSING',
    };
    if (judgment.state === 'admissible') bucket.latest_admissible_done_run = run;
    if (judgment.state === 'indeterminate') bucket.has_indeterminate_done = true;
  }

  #applyCurrentJudgment(
    obligationId: string,
    semanticKey: string,
    judgment: CurrentRealizationJudgment,
  ): void {
    const bucket = this.#bucket(obligationId, semanticKey);
    if (!bucket?.latest_done_run) {
      throw new Error(`OBSERVATION_WITHOUT_DONE_REALIZATION:${obligationId}`);
    }
    bucket.latest_admissible_done_run =
      judgment.state === 'admissible' ? bucket.latest_done_run : null;
    bucket.has_indeterminate_done = judgment.state === 'indeterminate';
  }

  #propagate(seed: string): MutationResult {
    const metrics = zeroMetrics();
    this.#readyHeap.takeComparisons();
    const touched = new Set<string>();
    const pending = [seed];
    const queued = new Set<string>([seed]);

    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const id = pending[cursor];
      queued.delete(id);
      const before = this.lifecycle(id);
      metrics.semantic_nodes_examined += 1;
      this.#recomputeNode(id, metrics);
      const after = this.lifecycle(id);
      touched.add(id);
      this.#refreshClaimability(id, metrics);

      const lifecycleChanged = before.status !== after.status;
      const doneRunChanged =
        before.status === 'DONE' && after.status === 'DONE' && before.run?.id !== after.run?.id;

      if (lifecycleChanged) {
        for (const downstream of this.#allDownstreams.get(id) ?? []) {
          metrics.dependency_edges_examined += 1;
          touched.add(downstream);
          this.#refreshClaimability(downstream, metrics);
        }
      }

      for (const downstream of this.#semanticDownstreams.get(id) ?? []) {
        metrics.dependency_edges_examined += 1;
        const consumedIdentityMayChange =
          lifecycleChanged || (doneRunChanged && downstream.selector === 'settlement-receipt');
        if (!consumedIdentityMayChange || queued.has(downstream.id)) continue;
        queued.add(downstream.id);
        pending.push(downstream.id);
      }
    }

    metrics.ready_candidates_examined =
      this.#readyHeap.takeComparisons() + (this.#readyHeap.peek() === null ? 0 : 1);
    return {
      touched_obligations: touched.size,
      selected_ready: this.#readyHeap.peek(),
      metrics,
    };
  }

  #recomputeNode(id: string, metrics?: MutationMetrics): boolean {
    const beforeKey = this.#semanticKeys.get(id) ?? null;
    const before = this.#lifecycles.get(id) ?? { status: 'UNREALIZED' as const };
    const beforeIndeterminate = this.#indeterminate.get(id) ?? false;
    const work = this.#fixture.state.obligations[id];
    if (metrics) {
      metrics.dependency_edges_examined += work.dependencies.filter(
        (edge) => edge.kind === 'semantic',
      ).length;
    }
    const key = obligationKey(this.#fixture.state, work, this.#lifecycles, this.#fixture.receipts);
    this.#semanticKeys.set(id, key);

    let lifecycle: Lifecycle = { status: 'UNREALIZED' };
    let indeterminate = false;
    if (key) {
      if (metrics) metrics.history_buckets_examined += 1;
      const bucket = this.#bucket(id, key);
      const done = bucket?.latest_admissible_done_run ?? null;
      const latest = bucket?.latest_run ?? null;
      indeterminate = done === null && (bucket?.has_indeterminate_done ?? false);

      if (done) {
        lifecycle = { status: 'DONE', run: done };
      } else if (latest) {
        const receipt = this.#fixture.receipts.get(latest.id);
        if (!receipt) {
          lifecycle = { status: 'EXECUTING', run: latest };
        } else if (receipt.disposition === 'WAITING') {
          lifecycle = {
            status:
              typeof receipt.execution_generation === 'number' &&
              latest.execution_generation > receipt.execution_generation
                ? 'EXECUTING'
                : 'WAITING',
            run: latest,
          };
        } else if (receipt.disposition === 'RECOVERY_REQUIRED') {
          lifecycle = { status: 'RECOVERY_REQUIRED', run: latest };
        }
      }
    }

    this.#lifecycles.set(id, lifecycle);
    this.#indeterminate.set(id, indeterminate);
    return (
      beforeKey !== key ||
      before.status !== lifecycle.status ||
      before.run?.id !== lifecycle.run?.id ||
      beforeIndeterminate !== indeterminate
    );
  }

  #refreshClaimability(id: string, metrics?: MutationMetrics): void {
    const previous = this.#claimability.get(id);
    let next: string | null = null;
    const lifecycle = this.lifecycle(id);

    if (lifecycle.status !== 'UNREALIZED') {
      next = 'NOT_READY';
    } else if (this.#indeterminate.get(id) === true) {
      next = 'CURRENT_REALIZATION_ADMISSIBILITY_INDETERMINATE';
    } else {
      const work = this.#fixture.state.obligations[id];
      let unsatisfied = false;
      for (const upstream of dependencyUpstreams(work)) {
        if (metrics) metrics.dependency_edges_examined += 1;
        if (this.lifecycle(upstream).status !== 'DONE') {
          unsatisfied = true;
          break;
        }
      }
      if (unsatisfied) {
        next = 'DEPENDENCIES_NOT_DONE';
      } else if (!this.semanticKey(id)) {
        next = 'SEMANTIC_DEPENDENCY_UNRESOLVED';
      }
    }

    this.#claimability.set(id, next);
    if (previous === next) return;
    const wasReady = this.#ready.has(id);
    const isReady = next === null;
    if (isReady && !wasReady) {
      this.#ready.add(id);
      this.#readyHeap.add(id);
    } else if (!isReady && wasReady) {
      this.#ready.delete(id);
      this.#readyHeap.remove(id);
    }
  }

  #serviceAge(id: string): number {
    const currentKey = this.semanticKey(id);
    if (currentKey) {
      const claimOrdinal = this.#bucket(id, currentKey)?.latest_claim_ordinal ?? null;
      if (claimOrdinal !== null) return claimOrdinal;
    }
    const binding = this.#fixture.bindingOrdinals.get(id);
    if (binding === undefined) throw new Error(`BINDING_ORDINAL_MISSING:${id}`);
    return binding;
  }
}

function productionReadyIds(project: ReturnType<typeof deriveProjectProjection>): Set<string> {
  return new Set(
    project.work
      .filter((candidate) => project.claimabilityErrors.get(candidate.id) === null)
      .map((candidate) => candidate.id),
  );
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function assertEquivalent(
  fixture: Fixture,
  treatment: IncrementalSemanticProjection,
  label: string,
): void {
  const project = projection(fixture);
  for (const id of Object.keys(fixture.state.obligations)) {
    assert.equal(
      treatment.semanticKey(id),
      project.semanticKeys.get(id) ?? null,
      `${label}:${id}:key`,
    );
    assert.equal(
      treatment.lifecycle(id).status,
      project.lifecycles.get(id)?.status,
      `${label}:${id}:status`,
    );
    assert.equal(
      treatment.lifecycle(id).run?.id ?? null,
      project.lifecycles.get(id)?.run?.id ?? null,
      `${label}:${id}:run`,
    );
    assert.equal(
      treatment.claimability(id),
      project.claimabilityErrors.get(id) ?? null,
      `${label}:${id}:claimability`,
    );
  }
  assert.ok(
    sameSet(treatment.readyIds(), productionReadyIds(project)),
    `${label}:ready-membership`,
  );
  assert.equal(
    treatment.selectedReady(),
    project.readyWork?.id ?? null,
    `${label}:ready-selection`,
  );
}

function applyObservation(
  fixture: Fixture,
  treatment: IncrementalSemanticProjection,
  obligationId: string,
  observed: Observation,
): MutationResult {
  const key = treatment.semanticKey(obligationId);
  if (!key) throw new Error(`OBSERVATION_WITHOUT_SEMANTIC_KEY:${obligationId}`);
  const judgment = classifyObservation(fixture, obligationId, observed);
  applyJudgmentToOracle(fixture, obligationId, key, judgment);
  return treatment.setCurrentRealization(obligationId, judgment);
}

function hostileState(): State {
  return stateFrom([
    obligation('root'),
    obligation('by-content', [semanticContent('root')]),
    obligation('by-settlement', [semanticSettlement('root')]),
    obligation('content-grandchild', [semanticContent('by-content')]),
    obligation('settlement-grandchild', [semanticSettlement('by-settlement')]),
    obligation('control-child', [control('root')]),
  ]);
}

function runHostileDifferential(): void {
  const order = [
    'root',
    'by-content',
    'by-settlement',
    'content-grandchild',
    'settlement-grandchild',
    'control-child',
  ] as const;
  const fixture = settleIds(hostileState(), order);
  const treatment = new IncrementalSemanticProjection(fixture);
  assertEquivalent(fixture, treatment, 'initial');

  const originalContentKey = treatment.semanticKey('by-content');
  const originalSettlementKey = treatment.semanticKey('by-settlement');
  const originalContentGrandchildRun = treatment.lifecycle('content-grandchild').run?.id;
  const originalSettlementGrandchildKey = treatment.semanticKey('settlement-grandchild');

  const steps: Array<{ name: string; run: () => MutationResult }> = [
    {
      name: 'root-indeterminate',
      run: () =>
        applyObservation(
          fixture,
          treatment,
          'root',
          uncertainObservation(fixture.state.obligations.root),
        ),
    },
    {
      name: 'root-restored',
      run: () =>
        applyObservation(
          fixture,
          treatment,
          'root',
          presentObservation(fixture.state.obligations.root, true),
        ),
    },
    {
      name: 'root-resettled-while-done',
      run: () => treatment.addDoneRealization('root', 'settlement-root-2'),
    },
    {
      name: 'root-rejected',
      run: () =>
        applyObservation(
          fixture,
          treatment,
          'root',
          presentObservation(fixture.state.obligations.root, false),
        ),
    },
    {
      name: 'root-resettled',
      run: () => treatment.addDoneRealization('root', 'settlement-root-3'),
    },
    {
      name: 'settlement-consumer-resettled',
      run: () => treatment.addDoneRealization('by-settlement', 'settlement-by-settlement-2'),
    },
    {
      name: 'settlement-grandchild-resettled',
      run: () => treatment.addDoneRealization('settlement-grandchild', 'settlement-grandchild-2'),
    },
    {
      name: 'content-consumer-rejected',
      run: () =>
        applyObservation(
          fixture,
          treatment,
          'by-content',
          presentObservation(fixture.state.obligations['by-content'], false),
        ),
    },
    {
      name: 'content-consumer-resettled',
      run: () => treatment.addDoneRealization('by-content', 'settlement-by-content-2'),
    },
    {
      name: 'content-consumer-currently-valid',
      run: () =>
        applyObservation(
          fixture,
          treatment,
          'by-content',
          presentObservation(fixture.state.obligations['by-content'], true),
        ),
    },
  ];

  const maxima = zeroMetrics();
  let maximumTouched = 0;
  for (const step of steps) {
    const result = step.run();
    maximumTouched = Math.max(maximumTouched, result.touched_obligations);
    for (const key of Object.keys(maxima) as Array<keyof MutationMetrics>) {
      maxima[key] = Math.max(maxima[key], result.metrics[key]);
    }
    assertEquivalent(fixture, treatment, step.name);

    if (step.name === 'root-resettled-while-done') {
      assert.equal(
        result.metrics.semantic_nodes_examined,
        3,
        'DONE-to-DONE resettlement should skip the verified-content branch',
      );
      assert.equal(
        treatment.semanticKey('by-content'),
        originalContentKey,
        'verified-content identity should survive DONE-to-DONE upstream resettlement',
      );
      assert.notEqual(
        treatment.semanticKey('by-settlement'),
        originalSettlementKey,
        'settlement-receipt identity should change after DONE-to-DONE upstream resettlement',
      );
    }

    if (step.name === 'root-resettled') {
      assert.equal(
        treatment.semanticKey('by-content'),
        originalContentKey,
        'verified-content identity should survive upstream resettlement',
      );
      assert.notEqual(
        treatment.semanticKey('by-settlement'),
        originalSettlementKey,
        'settlement-receipt identity should change after upstream resettlement',
      );
      assert.equal(
        treatment.lifecycle('by-content').status,
        'DONE',
        'verified-content consumer should reuse historical realization',
      );
      assert.equal(
        treatment.lifecycle('by-settlement').status,
        'UNREALIZED',
        'settlement-receipt consumer should invalidate after new settlement identity',
      );
    }

    if (step.name === 'content-consumer-currently-valid') {
      assert.equal(
        treatment.lifecycle('content-grandchild').run?.id,
        originalContentGrandchildRun,
        'verified-content grandchild should retain reusable historical realization',
      );
      assert.notEqual(
        treatment.semanticKey('settlement-grandchild'),
        originalSettlementGrandchildKey,
        'settlement-consumer branch should have acquired a new semantic identity',
      );
    }
  }

  assert.equal(maxima.historical_runs_examined, 0);
  console.log(
    JSON.stringify({
      kind: 'semantic-hostile-production-differential',
      transitions: steps.length,
      maximum_touched_obligations: maximumTouched,
      maximum_examined: maxima,
      verified_content_reuse: 'PASS',
      settlement_receipt_invalidation: 'PASS',
      current_realization_indeterminate_and_rejected: 'PASS',
      result: 'PASS',
    }),
  );
}

function runNegativeControl(): void {
  const state = stateFrom([
    obligation('root'),
    obligation('consumer', [semanticSettlement('root')]),
  ]);
  const fixture = settleIds(state, ['root', 'consumer']);
  const treatment = new IncrementalSemanticProjection(fixture);
  const key = treatment.semanticKey('root');
  assert.ok(key);
  const judgment = classifyObservation(
    fixture,
    'root',
    presentObservation(state.obligations.root, false),
  );
  applyJudgmentToOracle(fixture, 'root', key, judgment);
  treatment.setCurrentRealizationLocallyOnly('root', judgment);

  let divergenceDetected = false;
  try {
    assertEquivalent(fixture, treatment, 'negative-control');
  } catch {
    divergenceDetected = true;
  }
  assert.equal(divergenceDetected, true);

  console.log(
    JSON.stringify({
      kind: 'negative-control',
      omitted_derivative: 'semantic-descendant propagation',
      divergence_detected: true,
      result: 'PASS',
    }),
  );
}

function paddedSemanticState(size: number, depth: number): State {
  if (size < depth) throw new Error('PADDED_SEMANTIC_GRAPH_TOO_SMALL');
  const items: Obligation[] = [obligation('chain-0')];
  for (let index = 1; index < depth; index += 1) {
    items.push(obligation(`chain-${index}`, [semanticSettlement(`chain-${index - 1}`)]));
  }
  for (let index = depth; index < size; index += 1) {
    items.push(obligation(`padding-${String(index).padStart(5, '0')}`));
  }
  return stateFrom(items);
}

function runLocalityScaling(): void {
  const sizes = [128, 512, 2048, 8192];
  const depth = 5;
  const mutations = 40;
  const results: Array<Record<string, number>> = [];

  for (const size of sizes) {
    const state = paddedSemanticState(size, depth);
    const chain = Array.from({ length: depth }, (_, index) => `chain-${index}`);
    const fixture = settleIds(state, chain);
    const treatment = new IncrementalSemanticProjection(fixture);
    let treatmentMs = 0;
    let oracleMs = 0;
    const maxima = zeroMetrics();
    let maxTouched = 0;

    for (let index = 0; index < mutations; index += 1) {
      const observation =
        index % 2 === 0
          ? uncertainObservation(state.obligations['chain-0'])
          : presentObservation(state.obligations['chain-0'], true);
      const key = treatment.semanticKey('chain-0');
      assert.ok(key);
      const judgment = classifyObservation(fixture, 'chain-0', observation);
      applyJudgmentToOracle(fixture, 'chain-0', key, judgment);

      const treatmentStarted = performance.now();
      const result = treatment.setCurrentRealization('chain-0', judgment);
      const selected = result.selected_ready;
      treatmentMs += performance.now() - treatmentStarted;
      maxTouched = Math.max(maxTouched, result.touched_obligations);
      for (const metric of Object.keys(maxima) as Array<keyof MutationMetrics>) {
        maxima[metric] = Math.max(maxima[metric], result.metrics[metric]);
      }

      const oracleStarted = performance.now();
      const project = projection(fixture);
      oracleMs += performance.now() - oracleStarted;

      assert.equal(selected, project.readyWork?.id ?? null);
      assert.ok(sameSet(treatment.readyIds(), productionReadyIds(project)));
      for (const id of chain) {
        assert.equal(treatment.semanticKey(id), project.semanticKeys.get(id) ?? null);
        assert.equal(treatment.lifecycle(id).status, project.lifecycles.get(id)?.status);
        assert.equal(
          treatment.lifecycle(id).run?.id ?? null,
          project.lifecycles.get(id)?.run?.id ?? null,
        );
      }
    }

    const logarithmicReadyBound = 8 * depth * Math.ceil(Math.log2(size + 1));
    assert.equal(maxima.semantic_nodes_examined, depth);
    assert.equal(maxima.historical_runs_examined, 0);
    assert.ok(
      maxima.ready_candidates_examined <= logarithmicReadyBound,
      `READY_INDEX_NOT_LOCAL:${size}:${maxima.ready_candidates_examined}`,
    );
    results.push({
      obligations: size,
      semantic_chain_depth: depth,
      mutations,
      max_touched: maxTouched,
      max_semantic_nodes_examined: maxima.semantic_nodes_examined,
      max_dependency_edges_examined: maxima.dependency_edges_examined,
      max_history_buckets_examined: maxima.history_buckets_examined,
      max_historical_runs_examined: maxima.historical_runs_examined,
      max_ready_candidates_examined: maxima.ready_candidates_examined,
      ready_comparison_bound: logarithmicReadyBound,
      oracle_obligations_rederived_per_mutation: size,
      oracle_ms: Number(oracleMs.toFixed(3)),
      differential_ms: Number(treatmentMs.toFixed(3)),
      measured_speedup: Number((oracleMs / treatmentMs).toFixed(3)),
    });
  }

  console.log(JSON.stringify({ kind: 'semantic-locality-scaling', results, result: 'PASS' }));
}

function repeatedHistoryFixture(runCount: number): Fixture {
  const state = stateFrom([obligation('root')]);
  const fixture = emptyFixture(state);
  const key = projection(fixture).semanticKeys.get('root');
  assert.ok(key);
  for (let index = 0; index < runCount; index += 1) {
    addDoneRun(fixture, 'root', key, `settlement-root-${index + 1}`);
  }
  return fixture;
}

function runHistoryScaling(): void {
  const historySizes = [1, 10, 100, 1000];
  const mutations = 40;
  const results: Array<Record<string, number>> = [];

  for (const historySize of historySizes) {
    const fixture = repeatedHistoryFixture(historySize);
    const treatment = new IncrementalSemanticProjection(fixture);
    const maxima = zeroMetrics();
    let treatmentMs = 0;
    let oracleJudgmentUpdates = 0;

    for (let index = 0; index < mutations; index += 1) {
      const observation =
        index % 2 === 0
          ? presentObservation(fixture.state.obligations.root, false)
          : presentObservation(fixture.state.obligations.root, true);
      const key = treatment.semanticKey('root');
      assert.ok(key);
      const judgment = classifyObservation(fixture, 'root', observation);
      oracleJudgmentUpdates += applyJudgmentToOracle(fixture, 'root', key, judgment);

      const started = performance.now();
      const result = treatment.setCurrentRealization('root', judgment);
      const selected = result.selected_ready;
      treatmentMs += performance.now() - started;
      for (const metric of Object.keys(maxima) as Array<keyof MutationMetrics>) {
        maxima[metric] = Math.max(maxima[metric], result.metrics[metric]);
      }

      const project = projection(fixture);
      assert.equal(selected, project.readyWork?.id ?? null);
      assert.equal(treatment.lifecycle('root').status, project.lifecycles.get('root')?.status);
      assert.equal(
        treatment.lifecycle('root').run?.id ?? null,
        project.lifecycles.get('root')?.run?.id ?? null,
      );
    }

    assert.equal(maxima.history_buckets_examined, 1);
    assert.equal(maxima.historical_runs_examined, 0);
    results.push({
      historical_runs: historySize,
      mutations,
      max_history_buckets_examined: maxima.history_buckets_examined,
      max_historical_runs_examined: maxima.historical_runs_examined,
      oracle_judgment_updates: oracleJudgmentUpdates,
      differential_ms: Number(treatmentMs.toFixed(3)),
    });
  }

  console.log(JSON.stringify({ kind: 'semantic-history-scaling', results, result: 'PASS' }));
}

runNegativeControl();
runHostileDifferential();
runLocalityScaling();
runHistoryScaling();

console.log(
  JSON.stringify({
    kind: 'finite-difference-semantic-projection-summary',
    exact_production_differential: 'PASS',
    observation_is_explicit_input: true,
    semantic_key_propagation: 'PASS',
    current_realization_validity: 'PASS',
    omitted_derivative_negative_control: 'PASS',
    frontier_driven_propagation: 'PASS',
    indexed_ready_selection: 'PASS',
    history_bucket_lookup: 'PASS',
    result: 'PASS',
  }),
);
