import assert from 'node:assert/strict';

import {
  ancestorsOf,
  canonicalTrace,
  enumerateAll,
  eventMap,
  exploreWithSleepSets,
  traceKeys,
  type IndependenceOracle,
} from '../partial-order.ts';

type EventKind = 'claim' | 'reserve' | 'receipt' | 'effect';
type QuotientMode = 'safety' | 'scheduler';

interface Event {
  id: string;
  obligation: string;
  kind: EventKind;
  resource: string;
  parents: string[];
  outcome?: string;
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

function compareCorpus(mode: QuotientMode) {
  const events = independentChainsFixture();
  const oracle = conservativeOracle(events, mode);
  const exhaustive = enumerateAll(events);
  const reduced = exploreWithSleepSets(events, oracle);
  const exhaustiveKeys = traceKeys(exhaustive.executions, oracle);
  const reducedKeys = traceKeys(reduced.executions, oracle);

  assert.equal(exhaustive.executions.length, 369_600);
  assert.deepEqual([...reducedKeys].sort(), [...exhaustiveKeys].sort());
  assert.equal(reduced.executions.length, reducedKeys.size);

  const expectedClasses = mode === 'safety' ? 1 : 24;
  assert.equal(exhaustiveKeys.size, expectedClasses);
  assert.equal(reduced.executions.length, expectedClasses);

  return {
    mode,
    exhaustive_executions: exhaustive.executions.length,
    exhaustive_prefixes: exhaustive.prefixes,
    trace_classes: exhaustiveKeys.size,
    reduced_executions: reduced.executions.length,
    reduced_prefixes: reduced.prefixes,
    sleep_prunes: reduced.sleep_prunes,
    execution_reduction_ratio: exhaustive.executions.length / reduced.executions.length,
    exact_trace_class_match: true,
    exactly_one_execution_per_trace: true,
  };
}

function conflictingWritesFixture(): Event[] {
  return [
    {
      id: 'alpha/effect',
      obligation: 'alpha',
      kind: 'effect',
      resource: 'github-status:1:sha:ci/overcenter',
      parents: [],
      outcome: 'FAILURE',
    },
    {
      id: 'beta/effect',
      obligation: 'beta',
      kind: 'effect',
      resource: 'github-status:1:sha:ci/overcenter',
      parents: [],
      outcome: 'SUCCESS',
    },
  ];
}

function finalOutcome(sequence: readonly Event[]): string {
  let outcome = 'EMPTY';
  for (const event of sequence) {
    if (event.outcome) outcome = event.outcome;
  }
  return outcome;
}

function outcomes(executions: readonly Event[][]): Set<string> {
  return new Set(executions.map(finalOutcome));
}

function runConflictControl() {
  const events = conflictingWritesFixture();
  const conservative = conservativeOracle(events, 'safety');
  const exhaustive = enumerateAll(events);
  const reduced = exploreWithSleepSets(events, conservative);
  const unsound = exploreWithSleepSets(events, unsoundDistinctObligationOracle);

  const exhaustiveOutcomes = outcomes(exhaustive.executions);
  const reducedOutcomes = outcomes(reduced.executions);
  const unsoundOutcomes = outcomes(unsound.executions);

  assert.deepEqual([...reducedOutcomes].sort(), [...exhaustiveOutcomes].sort());
  assert.equal(exhaustive.executions.length, 2);
  assert.equal(reduced.executions.length, 2);
  assert.equal(exhaustiveOutcomes.size, 2);
  assert.equal(reducedOutcomes.size, 2);

  assert.equal(unsound.executions.length, 1);
  assert.equal(unsoundOutcomes.size, 1);
  assert.notDeepEqual([...unsoundOutcomes].sort(), [...exhaustiveOutcomes].sort());

  return {
    exhaustive_executions: exhaustive.executions.length,
    conservative_reduced_executions: reduced.executions.length,
    exhaustive_outcomes: exhaustiveOutcomes.size,
    conservative_outcomes: reducedOutcomes.size,
    unsound_reduced_executions: unsound.executions.length,
    unsound_outcomes: unsoundOutcomes.size,
    conservative_preserves_both_outcomes: true,
    unsound_oracle_misses_outcome: true,
  };
}

function dependentFutureFixture(): Event[] {
  return [
    {
      id: 'a/root',
      obligation: 'a',
      kind: 'claim',
      resource: 'provider/a',
      parents: [],
    },
    {
      id: 'b/root',
      obligation: 'b',
      kind: 'claim',
      resource: 'provider/b',
      parents: [],
    },
    {
      id: 'a/followup',
      obligation: 'a',
      kind: 'effect',
      resource: 'provider/shared',
      parents: ['a/root'],
      outcome: 'A',
    },
    {
      id: 'b/followup',
      obligation: 'b',
      kind: 'effect',
      resource: 'provider/shared',
      parents: ['b/root'],
      outcome: 'B',
    },
  ];
}

function runDependentFutureControl() {
  const events = dependentFutureFixture();
  const oracle = conservativeOracle(events, 'safety');
  const exhaustive = enumerateAll(events);
  const reduced = exploreWithSleepSets(events, oracle);
  const exhaustiveKeys = traceKeys(exhaustive.executions, oracle);
  const reducedKeys = traceKeys(reduced.executions, oracle);
  const exhaustiveOutcomes = outcomes(exhaustive.executions);
  const reducedOutcomes = outcomes(reduced.executions);

  assert.deepEqual([...reducedKeys].sort(), [...exhaustiveKeys].sort());
  assert.deepEqual([...reducedOutcomes].sort(), [...exhaustiveOutcomes].sort());
  assert.equal(exhaustiveOutcomes.size, 2);
  assert.equal(reducedOutcomes.size, 2);

  return {
    exhaustive_executions: exhaustive.executions.length,
    trace_classes: exhaustiveKeys.size,
    reduced_executions: reduced.executions.length,
    outcomes: reducedOutcomes.size,
    exact_trace_class_match: true,
    preserves_future_conflict_outcomes: true,
  };
}

const safety = compareCorpus('safety');
const scheduler = compareCorpus('scheduler');
const conflict = runConflictControl();
const dependentFuture = runDependentFutureControl();

console.log(JSON.stringify({ kind: 'dpor-causal-explorer-corpus', ...safety }));
console.log(JSON.stringify({ kind: 'dpor-causal-explorer-corpus', ...scheduler }));
console.log(JSON.stringify({ kind: 'dpor-causal-explorer-conflict-control', ...conflict }));
console.log(
  JSON.stringify({
    kind: 'dpor-causal-explorer-dependent-future-control',
    ...dependentFuture,
  }),
);
console.log(
  JSON.stringify({
    kind: 'dpor-causal-explorer-summary',
    result: 'supported',
    safety_exhaustive_executions: safety.exhaustive_executions,
    safety_reduced_executions: safety.reduced_executions,
    scheduler_exhaustive_executions: scheduler.exhaustive_executions,
    scheduler_reduced_executions: scheduler.reduced_executions,
    safety_execution_reduction_ratio: safety.execution_reduction_ratio,
    scheduler_execution_reduction_ratio: scheduler.execution_reduction_ratio,
    exact_trace_class_match: safety.exact_trace_class_match && scheduler.exact_trace_class_match,
    conflicting_outcomes_preserved: conflict.conservative_preserves_both_outcomes,
    future_conflict_outcomes_preserved: dependentFuture.preserves_future_conflict_outcomes,
    unsound_independence_rejected: conflict.unsound_oracle_misses_outcome,
  }),
);
