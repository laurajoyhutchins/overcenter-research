import assert from 'node:assert/strict';

import {
  buildStaticEffectIndex,
  staticEffectConflict,
} from '../../src/authority/admission.ts';
import {
  RECEIPT_SCHEMA,
  type HistoricalRun,
  type Receipt,
  type State,
} from '../../src/authority/facts.ts';
import { deriveProjectProjection } from '../../src/authority/project-state.ts';
import { obligationKey } from '../../src/graph/identity.ts';
import { buildGraphIndex, graphDependsOn } from '../../src/graph/topology.ts';
import type { Dependency, Obligation } from '../../src/model.ts';

type EventKind = 'claim' | 'reserve' | 'receipt';
type QuotientMode = 'safety' | 'scheduler';

interface Event {
  id: string;
  obligation: string;
  kind: EventKind;
  resource: string;
  parents: string[];
}

type IndependenceOracle = (left: Event, right: Event) => boolean;

function fileObligation(
  id: string,
  path: string,
  content: string,
  dependencies: Dependency[] = [],
): Obligation {
  return {
    id,
    dependencies,
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1',
      path,
      content,
    },
  };
}

function stateOf(obligations: Obligation[]): State {
  return {
    obligations: Object.fromEntries(obligations.map((obligation) => [obligation.id, obligation])),
    definition_ids: Object.fromEntries(
      obligations.map((obligation) => [obligation.id, 'definition-' + obligation.id]),
    ),
  };
}

function eventMap(events: readonly Event[]): Map<string, Event> {
  return new Map(events.map((event) => [event.id, event]));
}

function ancestorsOf(id: string, byId: ReadonlyMap<string, Event>, seen = new Set<string>()): Set<string> {
  const event = byId.get(id);
  if (!event) throw new Error('UNKNOWN_EVENT:' + id);
  for (const parent of event.parents) {
    if (seen.has(parent)) continue;
    seen.add(parent);
    ancestorsOf(parent, byId, seen);
  }
  return seen;
}

function conservativeOracle(events: readonly Event[], mode: QuotientMode): IndependenceOracle {
  const byId = eventMap(events);
  const ancestors = new Map(events.map((event) => [event.id, ancestorsOf(event.id, byId)]));

  return (left, right) => {
    if (left.id === right.id) return false;
    if (left.obligation === right.obligation) return false;
    if (ancestors.get(left.id)?.has(right.id) || ancestors.get(right.id)?.has(left.id)) {
      return false;
    }
    if (left.resource === right.resource) return false;
    if (mode === 'scheduler' && left.kind === 'claim' && right.kind === 'claim') return false;
    return true;
  };
}

function unsoundDistinctObligationOracle(left: Event, right: Event): boolean {
  return left.obligation !== right.obligation;
}

function canonicalTrace(
  sequence: readonly Event[],
  oracle: IndependenceOracle,
): string {
  const ids = sequence.map((event) => event.id);
  const byId = eventMap(sequence);
  const successors = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));

  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    const set = successors.get(from);
    if (!set) throw new Error('UNKNOWN_EVENT:' + from);
    if (set.has(to)) return;
    set.add(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  };

  for (const event of sequence) {
    for (const parent of event.parents) addEdge(parent, event.id);
  }

  for (let leftIndex = 0; leftIndex < sequence.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sequence.length; rightIndex += 1) {
      const left = sequence[leftIndex]!;
      const right = sequence[rightIndex]!;
      if (!oracle(left, right)) addEdge(left.id, right.id);
    }
  }

  const ready = ids.filter((id) => indegree.get(id) === 0).sort();
  const normalized: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    normalized.push(id);
    for (const successor of [...(successors.get(id) ?? [])].sort()) {
      const next = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, next);
      if (next === 0) {
        ready.push(successor);
        ready.sort();
      }
    }
  }

  if (normalized.length !== ids.length) throw new Error('TRACE_DEPENDENCY_CYCLE');
  for (const id of normalized) assert.ok(byId.has(id));
  return normalized.join(' ');
}

function enumerateLinearizations(
  events: readonly Event[],
  visit: (sequence: readonly Event[]) => void,
): number {
  const byId = eventMap(events);
  let count = 0;

  const walk = (done: Set<string>, sequence: Event[]) => {
    if (sequence.length === events.length) {
      count += 1;
      visit(sequence);
      return;
    }

    const ready = events
      .filter(
        (event) =>
          !done.has(event.id) &&
          event.parents.every((parent) => {
            if (!byId.has(parent)) throw new Error('UNKNOWN_PARENT:' + parent);
            return done.has(parent);
          }),
      )
      .sort((left, right) => left.id.localeCompare(right.id));

    assert.ok(ready.length > 0);
    for (const event of ready) {
      done.add(event.id);
      sequence.push(event);
      walk(done, sequence);
      sequence.pop();
      done.delete(event.id);
    }
  };

  walk(new Set(), []);
  return count;
}

function independentChainsFixture(): Event[] {
  return ['a', 'b', 'c', 'd'].flatMap((obligation) => [
    {
      id: obligation + '/claim',
      obligation,
      kind: 'claim' as const,
      resource: 'provider/' + obligation,
      parents: [],
    },
    {
      id: obligation + '/reserve',
      obligation,
      kind: 'reserve' as const,
      resource: 'provider/' + obligation,
      parents: [obligation + '/claim'],
    },
    {
      id: obligation + '/receipt',
      obligation,
      kind: 'receipt' as const,
      resource: 'provider/' + obligation,
      parents: [obligation + '/reserve'],
    },
  ]);
}

function runTraceReduction() {
  const events = independentChainsFixture();
  const safetyOracle = conservativeOracle(events, 'safety');
  const schedulerOracle = conservativeOracle(events, 'scheduler');
  const safetyTraces = new Set<string>();
  const schedulerTraces = new Set<string>();

  const linearizations = enumerateLinearizations(events, (sequence) => {
    safetyTraces.add(canonicalTrace(sequence, safetyOracle));
    schedulerTraces.add(canonicalTrace(sequence, schedulerOracle));
  });

  assert.equal(linearizations, 369_600);
  assert.equal(safetyTraces.size, 1);
  assert.equal(schedulerTraces.size, 24);

  return {
    events: events.length,
    obligations: 4,
    linearizations,
    safety_trace_classes: safetyTraces.size,
    scheduler_trace_classes: schedulerTraces.size,
    safety_reduction_ratio: linearizations / safetyTraces.size,
    scheduler_reduction_ratio: linearizations / schedulerTraces.size,
  };
}

function runProductionConflictAndCausalityControls() {
  const alpha = fileObligation('alpha', '/provider/shared', 'ALPHA');
  const beta = fileObligation('beta', '/provider/shared', 'BETA');
  const conflictState = stateOf([alpha, beta]);
  const conflictIndex = buildStaticEffectIndex(conflictState);
  const conflict = staticEffectConflict(conflictState, 'alpha', conflictIndex);
  assert.ok(conflict);
  assert.equal(conflict.code, 'UNORDERED_EFFECT_CONFLICT:alpha:beta');

  const orderedBeta = fileObligation('beta', '/provider/shared', 'BETA', [
    { kind: 'control', upstream: 'alpha' },
  ]);
  const orderedState = stateOf([alpha, orderedBeta]);
  const orderedIndex = buildStaticEffectIndex(orderedState);
  assert.equal(staticEffectConflict(orderedState, 'alpha', orderedIndex), null);
  assert.equal(staticEffectConflict(orderedState, 'beta', orderedIndex), null);

  const root = fileObligation('root', '/provider/root', 'ROOT');
  const control = fileObligation('control', '/provider/control', 'CONTROL', [
    { kind: 'control', upstream: 'root' },
  ]);
  const semantic = fileObligation('semantic', '/provider/semantic', 'SEMANTIC', [
    {
      kind: 'semantic',
      upstream: 'root',
      consumes: { kind: 'output', selector: 'verified-content' },
    },
  ]);
  const graph = buildGraphIndex(stateOf([root, control, semantic]));
  assert.equal(graphDependsOn(graph, 'control', 'root'), true);
  assert.equal(graphDependsOn(graph, 'semantic', 'root'), true);
  assert.equal(graphDependsOn(graph, 'root', 'semantic'), false);

  return {
    unordered_effect_conflict_detected: true,
    explicit_order_removes_static_conflict: true,
    control_dependency_detected: true,
    semantic_dependency_detected: true,
  };
}

interface SchedulerHarness {
  state: State;
  runs: Map<string, HistoricalRun>;
  receipts: Map<string, Receipt>;
  sequence: number;
}

function schedulerHarness(): SchedulerHarness {
  const obligations = [
    fileObligation('sched-a', '/provider/sched-a', 'A'),
    fileObligation('sched-b', '/provider/sched-b', 'B'),
  ];
  return {
    state: stateOf(obligations),
    runs: new Map(),
    receipts: new Map(),
    sequence: 0,
  };
}

function schedulerProjection(harness: SchedulerHarness, revision: string) {
  return deriveProjectProjection({
    state: harness.state,
    runs: harness.runs,
    receiptsByRun: harness.receipts,
    revision,
  });
}

function recordReadyClaim(harness: SchedulerHarness, id: string): void {
  const before = schedulerProjection(harness, 'before-' + harness.sequence);
  const obligation = harness.state.obligations[id];
  assert.ok(obligation);
  const key = obligationKey(harness.state, obligation, before.lifecycles, harness.receipts);
  assert.ok(key);

  harness.sequence += 1;
  const runId = 'run-' + harness.sequence + '-' + id;
  const claimCommit = 'claim-' + harness.sequence + '-' + id;
  const run: HistoricalRun = {
    id: runId,
    obligation_id: id,
    claimed_revision: 'revision-' + harness.sequence,
    claim_commit: claimCommit,
    obligation_key: key,
    execution_generation: 1,
    execution_authority_commit: claimCommit,
    execution_capability_sha256: '0'.repeat(64),
    obligation,
    definition_id: harness.state.definition_ids[id]!,
  };
  harness.runs.set(runId, run);
  harness.receipts.set(runId, {
    schema: RECEIPT_SCHEMA,
    run_id: runId,
    obligation_id: id,
    claimed_revision: run.claimed_revision,
    claim_commit: claimCommit,
    execution_generation: 1,
    execution_authority_commit: claimCommit,
    kind: 'observation',
    observed: null,
    settled_at: '2026-09-23T00:00:00.000Z',
    disposition: 'READY',
    verified: false,
  } as Receipt);
}

function schedulerOutcome(order: readonly string[]) {
  const harness = schedulerHarness();
  for (const id of order) recordReadyClaim(harness, id);
  const projection = schedulerProjection(harness, 'final');
  const statuses = projection.work
    .map((work) => [work.id, work.status] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const semanticKeys = [...projection.semanticKeys]
    .map(([id, key]) => [id, key] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    statuses,
    semanticKeys,
    ready_work: projection.readyWork?.id ?? null,
  };
}

function runSchedulerOrderControl() {
  const aThenB = schedulerOutcome(['sched-a', 'sched-b']);
  const bThenA = schedulerOutcome(['sched-b', 'sched-a']);

  assert.deepEqual(aThenB.statuses, bThenA.statuses);
  assert.deepEqual(aThenB.semanticKeys, bThenA.semanticKeys);
  assert.equal(aThenB.ready_work, 'sched-a');
  assert.equal(bThenA.ready_work, 'sched-b');
  assert.notEqual(aThenB.ready_work, bThenA.ready_work);

  return {
    same_lifecycle_projection: true,
    same_semantic_keys: true,
    a_then_b_ready_work: aThenB.ready_work,
    b_then_a_ready_work: bThenA.ready_work,
    scheduler_order_visible: true,
  };
}

function applyWrites(sequence: readonly Event[]): string {
  let value = 'EMPTY';
  for (const event of sequence) {
    if (event.obligation === 'alpha') value = 'ALPHA';
    if (event.obligation === 'beta') value = 'BETA';
  }
  return value;
}

function runUnsoundOracleControl() {
  const events: Event[] = [
    {
      id: 'alpha/effect',
      obligation: 'alpha',
      kind: 'reserve',
      resource: 'provider/shared',
      parents: [],
    },
    {
      id: 'beta/effect',
      obligation: 'beta',
      kind: 'reserve',
      resource: 'provider/shared',
      parents: [],
    },
  ];

  const conservative = conservativeOracle(events, 'safety');
  const correctClasses = new Map<string, Set<string>>();
  const unsoundClasses = new Map<string, Set<string>>();

  const linearizations = enumerateLinearizations(events, (sequence) => {
    const outcome = applyWrites(sequence);
    const correctKey = canonicalTrace(sequence, conservative);
    const unsoundKey = canonicalTrace(sequence, unsoundDistinctObligationOracle);
    const correctOutcomes = correctClasses.get(correctKey) ?? new Set<string>();
    correctOutcomes.add(outcome);
    correctClasses.set(correctKey, correctOutcomes);
    const unsoundOutcomes = unsoundClasses.get(unsoundKey) ?? new Set<string>();
    unsoundOutcomes.add(outcome);
    unsoundClasses.set(unsoundKey, unsoundOutcomes);
  });

  assert.equal(linearizations, 2);
  assert.equal(correctClasses.size, 2);
  assert.ok([...correctClasses.values()].every((outcomes) => outcomes.size === 1));
  assert.equal(unsoundClasses.size, 1);
  assert.deepEqual([...unsoundClasses.values()][0], new Set(['ALPHA', 'BETA']));

  return {
    linearizations,
    conservative_trace_classes: correctClasses.size,
    unsound_trace_classes: unsoundClasses.size,
    unsound_class_outcomes: [...unsoundClasses.values()][0]!.size,
    missed_counterexample_witness: true,
  };
}

const traceReduction = runTraceReduction();
const productionControls = runProductionConflictAndCausalityControls();
const schedulerControl = runSchedulerOrderControl();
const unsoundControl = runUnsoundOracleControl();

console.log(JSON.stringify({ kind: 'causal-execution-quotient-traces', ...traceReduction }));
console.log(JSON.stringify({ kind: 'causal-execution-quotient-production-controls', ...productionControls }));
console.log(JSON.stringify({ kind: 'causal-execution-quotient-scheduler-control', ...schedulerControl }));
console.log(JSON.stringify({ kind: 'causal-execution-quotient-unsound-control', ...unsoundControl }));
console.log(
  JSON.stringify({
    kind: 'causal-execution-quotient-summary',
    result: 'supported',
    full_linearizations: traceReduction.linearizations,
    safety_trace_classes: traceReduction.safety_trace_classes,
    scheduler_trace_classes: traceReduction.scheduler_trace_classes,
    safety_reduction_ratio: traceReduction.safety_reduction_ratio,
    scheduler_reduction_ratio: traceReduction.scheduler_reduction_ratio,
    scheduler_order_is_property_relevant: schedulerControl.scheduler_order_visible,
    naive_distinct_obligation_independence_is_unsound: unsoundControl.missed_counterexample_witness,
  }),
);
