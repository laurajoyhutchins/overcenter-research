import assert from 'node:assert/strict';

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
}

type IndependenceOracle = (left: Event, right: Event) => boolean;

function eventMap(events: readonly Event[]): Map<string, Event> {
  return new Map(events.map((event) => [event.id, event]));
}

function ancestorsOf(
  id: string,
  byId: ReadonlyMap<string, Event>,
  seen = new Set<string>(),
): Set<string> {
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

function enabledEvents(
  events: readonly Event[],
  done: ReadonlySet<string>,
  byId: ReadonlyMap<string, Event>,
): Event[] {
  return events
    .filter(
      (event) =>
        !done.has(event.id) &&
        event.parents.every((parent) => {
          if (!byId.has(parent)) throw new Error('UNKNOWN_PARENT:' + parent);
          return done.has(parent);
        }),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function enumerateAll(events: readonly Event[]): ExplorationResult {
  const byId = eventMap(events);
  const executions: Event[][] = [];
  let prefixes = 0;

  const visit = (done: Set<string>, sequence: Event[]): void => {
    prefixes += 1;
    if (sequence.length === events.length) {
      executions.push([...sequence]);
      return;
    }

    const ready = enabledEvents(events, done, byId);
    assert.ok(ready.length > 0);
    for (const event of ready) {
      done.add(event.id);
      sequence.push(event);
      visit(done, sequence);
      sequence.pop();
      done.delete(event.id);
    }
  };

  visit(new Set(), []);
  return { executions, prefixes, sleep_prunes: 0 };
}

function exploreWithSleepSets(
  events: readonly Event[],
  oracle: IndependenceOracle,
): ExplorationResult {
  const byId = eventMap(events);
  const executions: Event[][] = [];
  let prefixes = 0;
  let sleepPrunes = 0;

  const visit = (done: Set<string>, sequence: Event[], sleep: ReadonlySet<string>): void => {
    prefixes += 1;
    if (sequence.length === events.length) {
      executions.push([...sequence]);
      return;
    }

    const ready = enabledEvents(events, done, byId);
    assert.ok(ready.length > 0);

    const localSleep = new Set(sleep);
    for (const event of ready) {
      if (localSleep.has(event.id)) {
        sleepPrunes += 1;
        continue;
      }

      const nextSleep = new Set<string>();
      for (const sleepingId of localSleep) {
        const sleeping = byId.get(sleepingId);
        if (!sleeping) throw new Error('UNKNOWN_SLEEP_EVENT:' + sleepingId);
        if (oracle(sleeping, event)) nextSleep.add(sleepingId);
      }

      done.add(event.id);
      sequence.push(event);
      visit(done, sequence, nextSleep);
      sequence.pop();
      done.delete(event.id);

      localSleep.add(event.id);
    }
  };

  visit(new Set(), [], new Set());
  return { executions, prefixes, sleep_prunes: sleepPrunes };
}

function canonicalTrace(sequence: readonly Event[], oracle: IndependenceOracle): string {
  const ids = sequence.map((event) => event.id);
  const successors = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));

  const addEdge = (from: string, to: string): void => {
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

  if (normalized.length !== sequence.length) throw new Error('TRACE_DEPENDENCY_CYCLE');
  return normalized.join(' ');
}

function traceKeys(executions: readonly Event[][], oracle: IndependenceOracle): Set<string> {
  return new Set(executions.map((execution) => canonicalTrace(execution, oracle)));
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
