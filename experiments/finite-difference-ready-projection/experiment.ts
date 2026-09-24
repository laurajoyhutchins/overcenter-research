import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import type { Dependency, Obligation } from '../../src/model.ts';
import {
  normalizeObligation,
  RECEIPT_SCHEMA,
  type HistoricalRun,
  type Receipt,
  type State,
} from '../../src/authority/facts.ts';
import { deriveProjectProjection } from '../../src/authority/project-state.ts';
import { dependencyUpstreams, validateGraph } from '../../src/graph/topology.ts';

type Lifecycle = 'UNREALIZED' | 'EXECUTING' | 'WAITING' | 'RECOVERY_REQUIRED' | 'DONE';
type RelationName = 'lifecycle' | 'semanticResolved' | 'indeterminate' | 'conflict' | 'serviceAge';

type RelationStore = Record<RelationName, Map<string, unknown>>;

type ReadyClause =
  | {
      kind: 'self-equals';
      relation: Exclude<RelationName, 'serviceAge'>;
      value: unknown;
    }
  | {
      kind: 'all-dependencies-equal';
      relation: Exclude<RelationName, 'serviceAge'>;
      value: unknown;
    };

interface ReadyQuery {
  clauses: ReadyClause[];
  order: readonly ['serviceAge', 'id'];
}

interface OracleResult {
  ready: Set<string>;
  selected: string | null;
  examinedNodes: number;
  examinedEdges: number;
}

const READY_QUERY: ReadyQuery = {
  clauses: [
    { kind: 'self-equals', relation: 'lifecycle', value: 'UNREALIZED' },
    { kind: 'all-dependencies-equal', relation: 'lifecycle', value: 'DONE' },
    { kind: 'self-equals', relation: 'semanticResolved', value: true },
    { kind: 'self-equals', relation: 'indeterminate', value: false },
    { kind: 'self-equals', relation: 'conflict', value: false },
  ],
  order: ['serviceAge', 'id'],
};

function value(relations: RelationStore, relation: RelationName, id: string): unknown {
  return relations[relation].get(id);
}

function age(relations: RelationStore, id: string): number {
  const candidate = value(relations, 'serviceAge', id);
  if (typeof candidate !== 'number') throw new Error(`SERVICE_AGE_MISSING:${id}`);
  return candidate;
}

function compareReady(relations: RelationStore, left: string, right: string): number {
  return age(relations, left) - age(relations, right) || left.localeCompare(right);
}

function fullReadyOracle(
  state: State,
  relations: RelationStore,
  query: ReadyQuery = READY_QUERY,
): OracleResult {
  const ready = new Set<string>();
  let selected: string | null = null;
  let examinedNodes = 0;
  let examinedEdges = 0;

  for (const obligation of Object.values(state.obligations)) {
    examinedNodes += 1;
    let accepted = true;
    for (const clause of query.clauses) {
      if (clause.kind === 'self-equals') {
        if (!Object.is(value(relations, clause.relation, obligation.id), clause.value)) {
          accepted = false;
          break;
        }
        continue;
      }

      for (const upstream of dependencyUpstreams(obligation)) {
        examinedEdges += 1;
        if (!Object.is(value(relations, clause.relation, upstream), clause.value)) {
          accepted = false;
          break;
        }
      }
      if (!accepted) break;
    }

    if (!accepted) continue;
    ready.add(obligation.id);
    if (selected === null || compareReady(relations, obligation.id, selected) < 0) {
      selected = obligation.id;
    }
  }

  return { ready, selected, examinedNodes, examinedEdges };
}

class IndexedMinHeap {
  readonly #relations: RelationStore;
  readonly #items: string[] = [];
  readonly #positions = new Map<string, number>();

  constructor(relations: RelationStore) {
    this.#relations = relations;
  }

  get size(): number {
    return this.#items.length;
  }

  has(id: string): boolean {
    return this.#positions.has(id);
  }

  peek(): string | null {
    return this.#items[0] ?? null;
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

  rekey(id: string): void {
    const position = this.#positions.get(id);
    if (position === undefined) return;
    this.#repair(position);
  }

  #less(left: number, right: number): boolean {
    return compareReady(this.#relations, this.#items[left], this.#items[right]) < 0;
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

class FiniteDifferenceReady {
  readonly #state: State;
  readonly #relations: RelationStore;
  readonly #query: ReadyQuery;
  readonly #downstreams = new Map<string, Set<string>>();
  readonly #failingDependencyCounts = new Map<number, Map<string, number>>();
  readonly #ready = new Set<string>();
  readonly #heap: IndexedMinHeap;

  constructor(state: State, relations: RelationStore, query: ReadyQuery = READY_QUERY) {
    this.#state = state;
    this.#relations = relations;
    this.#query = query;
    this.#heap = new IndexedMinHeap(relations);
    this.#rebuildGraphIndexes();

    query.clauses.forEach((clause, index) => {
      if (clause.kind !== 'all-dependencies-equal') return;
      const counts = new Map<string, number>();
      for (const obligation of Object.values(state.obligations)) {
        counts.set(
          obligation.id,
          dependencyUpstreams(obligation).filter(
            (upstream) => !Object.is(value(relations, clause.relation, upstream), clause.value),
          ).length,
        );
      }
      this.#failingDependencyCounts.set(index, counts);
    });

    for (const id of Object.keys(state.obligations)) this.#refresh(id);
  }

  selected(): string | null {
    return this.#heap.peek();
  }

  readyCount(): number {
    return this.#ready.size;
  }

  readyIds(): Set<string> {
    return new Set(this.#ready);
  }

  setRelation(relation: RelationName, id: string, next: unknown): number {
    if (!this.#state.obligations[id]) throw new Error(`UNKNOWN_OBLIGATION:${id}`);
    const relationValues = this.#relations[relation];
    const previous = relationValues.get(id);
    if (Object.is(previous, next)) return 0;
    relationValues.set(id, next);

    const touched = new Set<string>();
    for (let index = 0; index < this.#query.clauses.length; index += 1) {
      const clause = this.#query.clauses[index];
      if (clause.relation !== relation) continue;
      if (clause.kind === 'self-equals') {
        touched.add(id);
        continue;
      }

      const wasPassing = Object.is(previous, clause.value);
      const isPassing = Object.is(next, clause.value);
      if (wasPassing === isPassing) continue;
      const delta = isPassing ? -1 : 1;
      const counts = this.#failingDependencyCounts.get(index)!;
      for (const downstream of this.#downstreams.get(id) ?? []) {
        counts.set(downstream, (counts.get(downstream) ?? 0) + delta);
        touched.add(downstream);
      }
    }

    if (relation === 'serviceAge') touched.add(id);
    for (const candidate of touched) this.#refresh(candidate);
    return touched.size;
  }

  replaceDependencies(id: string, dependencies: Dependency[]): number {
    const previous = this.#state.obligations[id];
    if (!previous) throw new Error(`UNKNOWN_OBLIGATION:${id}`);
    const replacement: Obligation = {
      ...structuredClone(previous),
      dependencies: structuredClone(dependencies),
    };
    const candidate: State = {
      obligations: { ...this.#state.obligations, [id]: replacement },
      definition_ids: { ...this.#state.definition_ids },
    };
    validateGraph(candidate);

    for (const upstream of dependencyUpstreams(previous))
      this.#downstreams.get(upstream)?.delete(id);
    this.#state.obligations[id] = replacement;
    for (const upstream of dependencyUpstreams(replacement)) {
      if (!this.#downstreams.has(upstream)) this.#downstreams.set(upstream, new Set());
      this.#downstreams.get(upstream)!.add(id);
    }

    this.#query.clauses.forEach((clause, index) => {
      if (clause.kind !== 'all-dependencies-equal') return;
      const failures = dependencyUpstreams(replacement).filter(
        (upstream) => !Object.is(value(this.#relations, clause.relation, upstream), clause.value),
      ).length;
      this.#failingDependencyCounts.get(index)!.set(id, failures);
    });
    this.#refresh(id);
    return 1;
  }

  addObligation(obligation: Obligation, serviceAge: number): number {
    if (this.#state.obligations[obligation.id]) {
      throw new Error(`DUPLICATE_OBLIGATION:${obligation.id}`);
    }
    const candidate: State = {
      obligations: { ...this.#state.obligations, [obligation.id]: structuredClone(obligation) },
      definition_ids: {
        ...this.#state.definition_ids,
        [obligation.id]: `experimental-${obligation.id}`,
      },
    };
    validateGraph(candidate);
    this.#state.obligations[obligation.id] = structuredClone(obligation);
    this.#state.definition_ids[obligation.id] = `experimental-${obligation.id}`;
    this.#downstreams.set(obligation.id, new Set());
    for (const upstream of dependencyUpstreams(obligation)) {
      if (!this.#downstreams.has(upstream)) this.#downstreams.set(upstream, new Set());
      this.#downstreams.get(upstream)!.add(obligation.id);
    }
    this.#relations.lifecycle.set(obligation.id, 'UNREALIZED');
    this.#relations.semanticResolved.set(obligation.id, true);
    this.#relations.indeterminate.set(obligation.id, false);
    this.#relations.conflict.set(obligation.id, false);
    this.#relations.serviceAge.set(obligation.id, serviceAge);

    this.#query.clauses.forEach((clause, index) => {
      if (clause.kind !== 'all-dependencies-equal') return;
      const failures = dependencyUpstreams(obligation).filter(
        (upstream) => !Object.is(value(this.#relations, clause.relation, upstream), clause.value),
      ).length;
      this.#failingDependencyCounts.get(index)!.set(obligation.id, failures);
    });
    this.#refresh(obligation.id);
    return 1;
  }

  retireLeaf(id: string): number {
    const obligation = this.#state.obligations[id];
    if (!obligation) throw new Error(`UNKNOWN_OBLIGATION:${id}`);
    if ((this.#downstreams.get(id)?.size ?? 0) !== 0) throw new Error(`RETIRE_NON_LEAF:${id}`);

    for (const upstream of dependencyUpstreams(obligation))
      this.#downstreams.get(upstream)?.delete(id);
    this.#ready.delete(id);
    this.#heap.remove(id);
    this.#downstreams.delete(id);
    for (const counts of this.#failingDependencyCounts.values()) counts.delete(id);
    for (const relation of Object.values(this.#relations)) relation.delete(id);
    delete this.#state.obligations[id];
    delete this.#state.definition_ids[id];
    validateGraph(this.#state);
    return 1;
  }

  #rebuildGraphIndexes(): void {
    for (const id of Object.keys(this.#state.obligations)) this.#downstreams.set(id, new Set());
    for (const obligation of Object.values(this.#state.obligations)) {
      for (const upstream of dependencyUpstreams(obligation)) {
        if (!this.#downstreams.has(upstream)) this.#downstreams.set(upstream, new Set());
        this.#downstreams.get(upstream)!.add(obligation.id);
      }
    }
  }

  #matches(id: string): boolean {
    for (let index = 0; index < this.#query.clauses.length; index += 1) {
      const clause = this.#query.clauses[index];
      if (clause.kind === 'self-equals') {
        if (!Object.is(value(this.#relations, clause.relation, id), clause.value)) return false;
        continue;
      }
      if ((this.#failingDependencyCounts.get(index)?.get(id) ?? 0) !== 0) return false;
    }
    return true;
  }

  #refresh(id: string): void {
    if (!this.#state.obligations[id]) return;
    const shouldBeReady = this.#matches(id);
    const isReady = this.#ready.has(id);
    if (shouldBeReady && !isReady) {
      this.#ready.add(id);
      this.#heap.add(id);
      return;
    }
    if (!shouldBeReady && isReady) {
      this.#ready.delete(id);
      this.#heap.remove(id);
      return;
    }
    if (shouldBeReady) this.#heap.rekey(id);
  }
}

function emptyRelations(state: State): RelationStore {
  const ids = Object.keys(state.obligations);
  return {
    lifecycle: new Map(ids.map((id) => [id, 'UNREALIZED' satisfies Lifecycle])),
    semanticResolved: new Map(ids.map((id) => [id, true])),
    indeterminate: new Map(ids.map((id) => [id, false])),
    conflict: new Map(ids.map((id) => [id, false])),
    serviceAge: new Map(ids.map((id, index) => [id, index + 1])),
  };
}

function obligation(id: string, dependencies: Dependency[] = []): Obligation {
  return normalizeObligation({
    id,
    dependencies,
    packet: { kind: 'finite-difference-ready-projection', id },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: `/tmp/overcenter-finite-difference/${id}`,
      content: id,
    },
  });
}

function stateFrom(obligations: Obligation[]): State {
  const state: State = { obligations: {}, definition_ids: {} };
  for (const item of obligations) {
    state.obligations[item.id] = structuredClone(item);
    state.definition_ids[item.id] = `experimental-${item.id}`;
  }
  validateGraph(state);
  return state;
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

function assertEquivalent(
  state: State,
  relations: RelationStore,
  treatment: FiniteDifferenceReady,
  label: string,
): OracleResult {
  const oracle = fullReadyOracle(state, relations);
  assert.equal(treatment.selected(), oracle.selected, `${label}: selected`);
  assert.equal(treatment.readyCount(), oracle.ready.size, `${label}: ready count`);
  assert.ok(sameSet(treatment.readyIds(), oracle.ready), `${label}: READY membership`);
  return oracle;
}

function control(upstream: string): Dependency {
  return { kind: 'control', upstream };
}

function semantic(upstream: string): Dependency {
  return { kind: 'semantic', upstream, consumes: { kind: 'output', selector: 'verified-content' } };
}

function runRelationalHostileCorpus(): void {
  const state = stateFrom([
    obligation('a'),
    obligation('b', [control('a')]),
    obligation('c', [control('a')]),
    obligation('d', [control('b'), control('c')]),
    obligation('e'),
    obligation('f', [semantic('e')]),
  ]);
  const relations = emptyRelations(state);
  const treatment = new FiniteDifferenceReady(state, relations);
  assertEquivalent(state, relations, treatment, 'initial');

  const steps: Array<() => number> = [
    () => treatment.setRelation('lifecycle', 'a', 'DONE'),
    () => treatment.setRelation('semanticResolved', 'c', false),
    () => treatment.setRelation('semanticResolved', 'c', true),
    () => treatment.setRelation('indeterminate', 'b', true),
    () => treatment.setRelation('indeterminate', 'b', false),
    () => treatment.setRelation('conflict', 'c', true),
    () => treatment.setRelation('conflict', 'c', false),
    () => treatment.setRelation('serviceAge', 'e', 0),
    () => treatment.replaceDependencies('e', [control('d')]),
    () => treatment.setRelation('lifecycle', 'b', 'DONE'),
    () => treatment.setRelation('lifecycle', 'c', 'DONE'),
    () => treatment.setRelation('lifecycle', 'd', 'DONE'),
    () => treatment.addObligation(obligation('g', [control('d')]), 100),
    () => treatment.retireLeaf('g'),
    () => treatment.setRelation('lifecycle', 'a', 'UNREALIZED'),
    () => treatment.setRelation('lifecycle', 'a', 'DONE'),
  ];

  let maximumTouched = 0;
  steps.forEach((step, index) => {
    maximumTouched = Math.max(maximumTouched, step());
    assertEquivalent(state, relations, treatment, `hostile-step-${index + 1}`);
  });

  console.log(
    JSON.stringify({
      kind: 'relational-hostile-corpus',
      transitions: steps.length,
      maximum_touched_obligations: maximumTouched,
      result: 'PASS',
    }),
  );
}

function makeProductionState(count: number): State {
  const items: Obligation[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `task-${String(index).padStart(3, '0')}`;
    const dependencies: Dependency[] = [];
    if (index > 0) dependencies.push(control(`task-${String(index - 1).padStart(3, '0')}`));
    if (index >= 4 && index % 4 === 0) {
      dependencies.push(control(`task-${String(index - 4).padStart(3, '0')}`));
    }
    items.push(obligation(id, dependencies));
  }
  return stateFrom(items);
}

function productionReadyIds(project: ReturnType<typeof deriveProjectProjection>): Set<string> {
  return new Set(
    project.work.filter((candidate) => candidate.status === 'READY').map((item) => item.id),
  );
}

function runProductionDifferential(): void {
  const state = makeProductionState(96);
  const relations = emptyRelations(state);
  const ids = Object.keys(state.obligations);
  const currentBindingOrdinals = new Map(ids.map((id, index) => [id, index + 1]));
  const claimOrdinalsByRun = new Map<string, number>();
  relations.serviceAge = new Map(currentBindingOrdinals);
  const treatment = new FiniteDifferenceReady(state, relations);
  const runs = new Map<string, HistoricalRun>();
  const receiptsByRun = new Map<string, Receipt>();

  for (let step = 0; step <= ids.length; step += 1) {
    const project = deriveProjectProjection({
      state,
      runs,
      receiptsByRun,
      revision: `revision-${step}`,
      currentBindingOrdinals,
      claimOrdinalsByRun,
    });
    assert.equal(
      treatment.selected(),
      project.readyWork?.id ?? null,
      `production-step-${step}: selected`,
    );
    assert.ok(
      sameSet(treatment.readyIds(), productionReadyIds(project)),
      `production-step-${step}: READY membership`,
    );
    if (step === ids.length) break;

    const selected = project.readyWork;
    assert.ok(selected, `production-step-${step}: missing READY work`);
    const semanticKey = project.semanticKeys.get(selected.id);
    assert.ok(semanticKey, `production-step-${step}: missing semantic key`);

    const runId = `run-${String(step).padStart(3, '0')}`;
    const claimCommit = `claim-${String(step).padStart(3, '0')}`;
    const run: HistoricalRun = {
      id: runId,
      obligation_id: selected.id,
      claimed_revision: `revision-${step}`,
      claim_commit: claimCommit,
      obligation_key: semanticKey,
      execution_generation: 1,
      execution_authority_commit: claimCommit,
      execution_capability_sha256: 'a'.repeat(64),
      obligation: structuredClone(state.obligations[selected.id]),
      definition_id: state.definition_ids[selected.id],
    };
    const receipt: Receipt = {
      schema: RECEIPT_SCHEMA,
      run_id: runId,
      obligation_id: selected.id,
      claimed_revision: run.claimed_revision,
      claim_commit: run.claim_commit,
      execution_generation: 1,
      execution_authority_commit: run.execution_authority_commit,
      kind: 'observation',
      observed: null,
      settled_at: '2026-09-23T00:00:00.000Z',
      disposition: 'DONE',
      verified: true,
      settlement_commit: `settlement-${String(step).padStart(3, '0')}`,
    };
    runs.set(runId, run);
    receiptsByRun.set(runId, receipt);
    claimOrdinalsByRun.set(runId, ids.length + step + 1);
    treatment.setRelation('lifecycle', selected.id, 'DONE');
  }

  console.log(
    JSON.stringify({
      kind: 'production-projection-differential',
      obligations: ids.length,
      prefixes_checked: ids.length + 1,
      result: 'PASS',
    }),
  );
}

function runNegativeControl(): void {
  const state = stateFrom([
    obligation('upstream'),
    obligation('downstream', [control('upstream')]),
  ]);
  const relations = emptyRelations(state);
  const before = fullReadyOracle(state, relations);
  assert.deepEqual([...before.ready].sort(), ['upstream']);

  relations.lifecycle.set('upstream', 'DONE');
  const after = fullReadyOracle(state, relations);
  const brokenDelta = new Set(before.ready);
  brokenDelta.delete('upstream');
  assert.ok(
    !sameSet(brokenDelta, after.ready),
    'negative control failed to expose stale downstream',
  );
  assert.deepEqual([...after.ready].sort(), ['downstream']);

  console.log(
    JSON.stringify({
      kind: 'negative-control',
      omitted_derivative: 'reverse dependency propagation',
      divergence_detected: true,
      result: 'PASS',
    }),
  );
}

function paddedGraph(size: number, fanout: number): State {
  if (size < fanout + 1) throw new Error('PADDED_GRAPH_TOO_SMALL');
  const items = [obligation('anchor')];
  for (let index = 0; index < fanout; index += 1) {
    items.push(obligation(`dependent-${index}`, [control('anchor')]));
  }
  for (let index = items.length; index < size; index += 1) {
    items.push(obligation(`padding-${String(index).padStart(5, '0')}`));
  }
  return stateFrom(items);
}

function runLocalityScaling(): void {
  const sizes = [128, 512, 2048, 8192];
  const mutations = 400;
  const results: Array<Record<string, number>> = [];

  for (const size of sizes) {
    const state = paddedGraph(size, 4);
    const relations = emptyRelations(state);
    const treatment = new FiniteDifferenceReady(state, relations);
    let oracleMs = 0;
    let differentialMs = 0;
    let maxTouched = 0;
    let examinedNodes = 0;

    for (let index = 0; index < mutations; index += 1) {
      const next: Lifecycle = index % 2 === 0 ? 'DONE' : 'UNREALIZED';

      const diffStarted = performance.now();
      const touched = treatment.setRelation('lifecycle', 'anchor', next);
      differentialMs += performance.now() - diffStarted;
      maxTouched = Math.max(maxTouched, touched);

      const oracleStarted = performance.now();
      const oracle = fullReadyOracle(state, relations);
      oracleMs += performance.now() - oracleStarted;
      examinedNodes += oracle.examinedNodes;

      assert.equal(treatment.selected(), oracle.selected, `locality-${size}-${index}: selected`);
      assert.equal(
        treatment.readyCount(),
        oracle.ready.size,
        `locality-${size}-${index}: ready count`,
      );
    }

    assert.ok(maxTouched <= 5, `locality-${size}: touched ${maxTouched}`);
    results.push({
      obligations: size,
      mutations,
      max_touched: maxTouched,
      mean_oracle_nodes_examined: examinedNodes / mutations,
      oracle_ms: Number(oracleMs.toFixed(3)),
      differential_ms: Number(differentialMs.toFixed(3)),
      measured_speedup: Number((oracleMs / differentialMs).toFixed(3)),
    });
  }

  const largest = results.at(-1)!;
  assert.equal(largest.max_touched, 5);
  assert.equal(largest.mean_oracle_nodes_examined, 8192);

  console.log(JSON.stringify({ kind: 'locality-scaling', results, result: 'PASS' }));
}

function runFanoutScaling(): void {
  const fanouts = [1, 8, 64, 512];
  const results = fanouts.map((fanout) => {
    const state = paddedGraph(fanout + 1, fanout);
    const relations = emptyRelations(state);
    const treatment = new FiniteDifferenceReady(state, relations);
    const touched = treatment.setRelation('lifecycle', 'anchor', 'DONE');
    const oracle = assertEquivalent(state, relations, treatment, `fanout-${fanout}`);
    assert.equal(touched, fanout + 1);
    return {
      fanout,
      obligations: fanout + 1,
      touched,
      oracle_nodes_examined: oracle.examinedNodes,
    };
  });

  console.log(JSON.stringify({ kind: 'fanout-scaling', results, result: 'PASS' }));
}

runNegativeControl();
runRelationalHostileCorpus();
runProductionDifferential();
runLocalityScaling();
runFanoutScaling();

console.log(
  JSON.stringify({
    kind: 'finite-difference-ready-projection-summary',
    oracle_equivalence: 'PASS',
    production_projection_differential: 'PASS',
    omitted_derivative_negative_control: 'PASS',
    locality_bound: 'affected reverse-dependency frontier',
    result: 'PASS',
  }),
);
