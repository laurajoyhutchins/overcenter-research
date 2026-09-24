import assert from 'node:assert/strict';

import {
  canonicalTrace,
  causalAncestors,
  enabledEvents,
  enumerateExecutions as enumerateAll,
  eventMap,
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

interface ExplorationResult {
  executions: Event[][];
  prefixes: number;
  sleep_prunes: number;
  races: number;
  initial_backtrack_insertions: number;
  race_backtrack_insertions: number;
}


function conservativeOracle(events: readonly Event[], mode: QuotientMode): IndependenceOracle {
  const ancestors = causalAncestors(events);

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

function exploreWithRaceBacktracking(
  events: readonly Event[],
  oracle: IndependenceOracle,
): ExplorationResult {
  const byId = eventMap(events);
  const ancestors = causalAncestors(events);
  const backtrack = new Map<string, Set<string>>();
  const exploredChoices = new Map<string, Set<string>>();
  const executions: Event[][] = [];
  let prefixes = 0;
  let sleepPrunes = 0;
  let races = 0;
  let initialBacktrackInsertions = 0;
  let raceBacktrackInsertions = 0;

  const prefixKey = (sequence: readonly Event[]): string =>
    sequence.map((event) => event.id).join('\u001f');

  const addBacktrack = (
    key: string,
    eventId: string,
    reason: 'initial' | 'race',
  ): void => {
    const choices = backtrack.get(key) ?? new Set<string>();
    if (!choices.has(eventId)) {
      choices.add(eventId);
      if (reason === 'initial') initialBacktrackInsertions += 1;
      else raceBacktrackInsertions += 1;
    }
    backtrack.set(key, choices);
  };

  const detectRaces = (sequence: readonly Event[]): void => {
    const currentIndex = sequence.length - 1;
    const current = sequence[currentIndex]!;

    for (let priorIndex = 0; priorIndex < currentIndex; priorIndex += 1) {
      const prior = sequence[priorIndex]!;
      if (oracle(prior, current)) continue;
      if (ancestors.get(current.id)?.has(prior.id) || ancestors.get(prior.id)?.has(current.id)) {
        continue;
      }

      races += 1;
      const beforePrior = sequence.slice(0, priorIndex);
      const doneBeforePrior = new Set(beforePrior.map((event) => event.id));
      const readyBeforePrior = enabledEvents(events, doneBeforePrior, byId);
      const reorderRoot = readyBeforePrior.find(
        (candidate) => candidate.obligation === current.obligation,
      );
      if (reorderRoot) addBacktrack(prefixKey(beforePrior), reorderRoot.id, 'race');
    }
  };

  const visit = (sequence: Event[], done: Set<string>, sleep: ReadonlySet<string>): void => {
    prefixes += 1;
    if (sequence.length === events.length) {
      executions.push([...sequence]);
      return;
    }

    const ready = enabledEvents(events, done, byId);
    assert.ok(ready.length > 0);
    const key = prefixKey(sequence);
    const choices = backtrack.get(key) ?? new Set<string>();

    if (choices.size === 0) {
      const first = ready.find((event) => !sleep.has(event.id));
      if (!first) return;
      addBacktrack(key, first.id, 'initial');
    }

    const explored = exploredChoices.get(key) ?? new Set<string>();
    exploredChoices.set(key, explored);

    while (true) {
      const pending = [...(backtrack.get(key) ?? [])]
        .filter((eventId) => !explored.has(eventId))
        .sort();
      if (pending.length === 0) break;

      const eventId = pending[0]!;
      explored.add(eventId);
      if (sleep.has(eventId)) {
        sleepPrunes += 1;
        continue;
      }

      const event = byId.get(eventId);
      if (!event) throw new Error('UNKNOWN_BACKTRACK_EVENT:' + eventId);
      if (!ready.some((candidate) => candidate.id === eventId)) {
        throw new Error('BACKTRACK_EVENT_NOT_ENABLED:' + eventId);
      }

      const nextSleep = new Set<string>();
      for (const sleepingId of sleep) {
        const sleeping = byId.get(sleepingId);
        if (!sleeping) throw new Error('UNKNOWN_SLEEP_EVENT:' + sleepingId);
        if (oracle(sleeping, event)) nextSleep.add(sleepingId);
      }

      sequence.push(event);
      done.add(event.id);
      detectRaces(sequence);
      visit(sequence, done, nextSleep);
      done.delete(event.id);
      sequence.pop();

      sleep = new Set(sleep);
      sleep.add(event.id);
    }
  };

  visit([], new Set(), new Set());
  return {
    executions,
    prefixes,
    sleep_prunes: sleepPrunes,
    races,
    initial_backtrack_insertions: initialBacktrackInsertions,
    race_backtrack_insertions: raceBacktrackInsertions,
  };
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
  const reduced = exploreWithRaceBacktracking(events, oracle);
  const exhaustiveKeys = traceKeys(exhaustive, oracle);
  const reducedKeys = traceKeys(reduced.executions, oracle);

  assert.equal(exhaustive.length, 369_600);
  assert.deepEqual([...reducedKeys].sort(), [...exhaustiveKeys].sort());
  assert.equal(reduced.executions.length, reducedKeys.size);

  const expectedClasses = mode === 'safety' ? 1 : 24;
  assert.equal(exhaustiveKeys.size, expectedClasses);
  assert.equal(reduced.executions.length, expectedClasses);
  if (mode === 'safety') assert.equal(reduced.races, 0);
  if (mode === 'scheduler') assert.ok(reduced.races > 0);

  return {
    mode,
    exhaustive_executions: exhaustive.length,
    trace_classes: exhaustiveKeys.size,
    reduced_executions: reduced.executions.length,
    reduced_prefixes: reduced.prefixes,
    races: reduced.races,
    initial_backtrack_insertions: reduced.initial_backtrack_insertions,
    race_backtrack_insertions: reduced.race_backtrack_insertions,
    sleep_prunes: reduced.sleep_prunes,
    execution_reduction_ratio: exhaustive.length / reduced.executions.length,
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
  const reduced = exploreWithRaceBacktracking(events, conservative);
  const unsound = exploreWithRaceBacktracking(events, unsoundDistinctObligationOracle);

  const exhaustiveOutcomes = outcomes(exhaustive);
  const reducedOutcomes = outcomes(reduced.executions);
  const unsoundOutcomes = outcomes(unsound.executions);

  assert.equal(exhaustive.length, 2);
  assert.equal(reduced.executions.length, 2);
  assert.deepEqual([...reducedOutcomes].sort(), [...exhaustiveOutcomes].sort());
  assert.ok(reduced.races > 0);
  assert.ok(reduced.race_backtrack_insertions > 0);

  assert.equal(unsound.executions.length, 1);
  assert.equal(unsoundOutcomes.size, 1);
  assert.notDeepEqual([...unsoundOutcomes].sort(), [...exhaustiveOutcomes].sort());

  return {
    exhaustive_executions: exhaustive.length,
    conservative_reduced_executions: reduced.executions.length,
    conservative_races: reduced.races,
    conservative_initial_backtrack_insertions: reduced.initial_backtrack_insertions,
    race_backtrack_insertions: reduced.race_backtrack_insertions,
    exhaustive_outcomes: exhaustiveOutcomes.size,
    conservative_outcomes: reducedOutcomes.size,
    unsound_reduced_executions: unsound.executions.length,
    unsound_outcomes: unsoundOutcomes.size,
    race_backtracking_preserves_both_outcomes: true,
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
  const reduced = exploreWithRaceBacktracking(events, oracle);
  const exhaustiveKeys = traceKeys(exhaustive, oracle);
  const reducedKeys = traceKeys(reduced.executions, oracle);
  const exhaustiveOutcomes = outcomes(exhaustive);
  const reducedOutcomes = outcomes(reduced.executions);

  assert.equal(exhaustive.length, 6);
  assert.equal(exhaustiveKeys.size, 2);
  assert.equal(reduced.executions.length, 2);
  assert.deepEqual([...reducedKeys].sort(), [...exhaustiveKeys].sort());
  assert.deepEqual([...reducedOutcomes].sort(), [...exhaustiveOutcomes].sort());
  assert.equal(reducedOutcomes.size, 2);
  assert.ok(reduced.races > 0);
  assert.ok(reduced.race_backtrack_insertions > 0);

  return {
    exhaustive_executions: exhaustive.length,
    trace_classes: exhaustiveKeys.size,
    reduced_executions: reduced.executions.length,
    reduced_prefixes: reduced.prefixes,
    races: reduced.races,
    initial_backtrack_insertions: reduced.initial_backtrack_insertions,
    race_backtrack_insertions: reduced.race_backtrack_insertions,
    outcomes: reducedOutcomes.size,
    exact_trace_class_match: true,
    race_backtracking_reaches_future_conflict: true,
  };
}

function crossObligationCausalCounterexampleFixture(): Event[] {
  return [
    {
      id: 'a/claim',
      obligation: 'a',
      kind: 'claim',
      resource: 'provider/y',
      parents: [],
    },
    {
      id: 'a/reserve',
      obligation: 'a',
      kind: 'reserve',
      resource: 'provider/y',
      parents: ['a/claim'],
    },
    {
      id: 'a/effect',
      obligation: 'a',
      kind: 'effect',
      resource: 'provider/x',
      parents: ['a/reserve'],
    },
    {
      id: 'b/root',
      obligation: 'b',
      kind: 'claim',
      resource: 'provider/y',
      parents: [],
    },
    {
      id: 'c/effect',
      obligation: 'c',
      kind: 'effect',
      resource: 'provider/x',
      parents: ['b/root'],
    },
  ];
}

function runCrossObligationCausalCounterexample() {
  const events = crossObligationCausalCounterexampleFixture();
  const oracle = conservativeOracle(events, 'safety');
  const exhaustive = enumerateAll(events);
  const reduced = exploreWithRaceBacktracking(events, oracle);
  const exhaustiveKeys = traceKeys(exhaustive, oracle);
  const reducedKeys = traceKeys(reduced.executions, oracle);
  const missing = [...exhaustiveKeys].filter((key) => !reducedKeys.has(key)).sort();

  assert.equal(exhaustive.length, 10);
  assert.equal(exhaustiveKeys.size, 6);
  assert.equal(reducedKeys.size, 5);
  assert.equal(missing.length, 1);

  return {
    exhaustive_executions: exhaustive.length,
    exhaustive_trace_classes: exhaustiveKeys.size,
    reduced_executions: reduced.executions.length,
    reduced_trace_classes: reducedKeys.size,
    missing_trace_classes: missing.length,
    current_backtracking_rule_incomplete: true,
  };
}

const safety = compareCorpus('safety');
const scheduler = compareCorpus('scheduler');
const conflict = runConflictControl();
const dependentFuture = runDependentFutureControl();
const crossObligation = runCrossObligationCausalCounterexample();

console.log(JSON.stringify({ kind: 'dpor-race-backtracking-corpus', ...safety }));
console.log(JSON.stringify({ kind: 'dpor-race-backtracking-corpus', ...scheduler }));
console.log(JSON.stringify({ kind: 'dpor-race-backtracking-conflict-control', ...conflict }));
console.log(
  JSON.stringify({
    kind: 'dpor-race-backtracking-dependent-future-control',
    ...dependentFuture,
  }),
);
console.log(
  JSON.stringify({
    kind: 'dpor-race-backtracking-cross-obligation-counterexample',
    ...crossObligation,
  }),
);
console.log(
  JSON.stringify({
    kind: 'dpor-race-backtracking-summary',
    result: 'mixed',
    safety_exhaustive_executions: safety.exhaustive_executions,
    safety_reduced_executions: safety.reduced_executions,
    scheduler_exhaustive_executions: scheduler.exhaustive_executions,
    scheduler_reduced_executions: scheduler.reduced_executions,
    safety_execution_reduction_ratio: safety.execution_reduction_ratio,
    scheduler_execution_reduction_ratio: scheduler.execution_reduction_ratio,
    exact_trace_class_match: safety.exact_trace_class_match && scheduler.exact_trace_class_match,
    scheduler_races_detected: scheduler.races > 0,
    conflicting_race_backtracking: conflict.race_backtracking_preserves_both_outcomes,
    future_conflict_race_backtracking: dependentFuture.race_backtracking_reaches_future_conflict,
    unsound_independence_rejected: conflict.unsound_oracle_misses_outcome,
    cross_obligation_counterexample_found:
      crossObligation.current_backtracking_rule_incomplete,
  }),
);
