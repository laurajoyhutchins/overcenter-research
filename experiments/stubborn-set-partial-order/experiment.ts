import assert from 'node:assert/strict';

import {
  causalAncestors,
  canonicalTrace,
  enabledEvents,
  enumerateExecutions,
  eventMap,
  traceKeys,
  type IndependenceOracle,
} from '../partial-order.ts';

type EventKind = 'claim' | 'effect';

interface Event {
  id: string;
  obligation: string;
  kind: EventKind;
  resource: string;
  parents: string[];
  outcome?: string;
}

function conservativeOracle(events: readonly Event[]): IndependenceOracle<Event> {
  const ancestors = causalAncestors(events);
  return (left, right) => {
    if (left.id === right.id) return false;
    if (left.obligation === right.obligation) return false;
    if (ancestors.get(left.id)?.has(right.id) || ancestors.get(right.id)?.has(left.id)) {
      return false;
    }
    return left.resource !== right.resource;
  };
}

function stubbornChoices(
  events: readonly Event[],
  done: ReadonlySet<string>,
  oracle: IndependenceOracle<Event>,
): Event[] {
  const byId = eventMap(events);
  const enabled = enabledEvents(events, done, byId);
  if (enabled.length === 0) return [];

  const remaining = events.filter((event) => !done.has(event.id));
  const stubborn = new Set<string>([enabled[0]!.id]);
  const pending = [enabled[0]!.id];

  const include = (id: string): void => {
    if (done.has(id) || stubborn.has(id)) return;
    stubborn.add(id);
    pending.push(id);
  };

  while (pending.length > 0) {
    const id = pending.pop()!;
    const event = byId.get(id);
    if (!event) throw new Error('UNKNOWN_STUBBORN_EVENT:' + id);

    const unmetParents = event.parents.filter((parent) => !done.has(parent));
    if (unmetParents.length > 0) {
      for (const parent of unmetParents) include(parent);
      continue;
    }

    for (const other of remaining) {
      if (other.id === event.id) continue;
      if (!oracle(event, other)) include(other.id);
    }
  }

  return enabled.filter((event) => stubborn.has(event.id));
}

function exploreWithStubbornSleepSets(
  events: readonly Event[],
  oracle: IndependenceOracle<Event>,
): { executions: Event[][]; prefixes: number; choice_sum: number } {
  const byId = eventMap(events);
  const executions: Event[][] = [];
  let prefixes = 0;
  let choiceSum = 0;

  const visit = (done: Set<string>, sequence: Event[], sleep: ReadonlySet<string>): void => {
    prefixes += 1;
    if (sequence.length === events.length) {
      executions.push([...sequence]);
      return;
    }

    const choices = stubbornChoices(events, done, oracle);
    if (choices.length === 0) throw new Error('STUBBORN_SET_DEAD_END');
    choiceSum += choices.length;

    const localSleep = new Set(sleep);
    for (const event of choices) {
      if (localSleep.has(event.id)) continue;

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
  return { executions, prefixes, choice_sum: choiceSum };
}

function assertTraceComplete(events: readonly Event[]) {
  const oracle = conservativeOracle(events);
  const exhaustive = enumerateExecutions(events);
  const reduced = exploreWithStubbornSleepSets(events, oracle);
  const exhaustiveKeys = traceKeys(exhaustive, oracle);
  const reducedKeys = traceKeys(reduced.executions, oracle);

  assert.deepEqual([...reducedKeys].sort(), [...exhaustiveKeys].sort());
  assert.equal(reduced.executions.length, reducedKeys.size);

  return {
    exhaustive_executions: exhaustive.length,
    trace_classes: exhaustiveKeys.size,
    reduced_executions: reduced.executions.length,
    reduced_prefixes: reduced.prefixes,
    choice_sum: reduced.choice_sum,
  };
}

function independentChainsFixture(): Event[] {
  return ['a', 'b', 'c', 'd'].flatMap((obligation) => [
    {
      id: obligation + '/claim',
      obligation,
      kind: 'claim' as const,
      resource: 'claim/' + obligation,
      parents: [],
    },
    {
      id: obligation + '/effect',
      obligation,
      kind: 'effect' as const,
      resource: 'effect/' + obligation,
      parents: [obligation + '/claim'],
    },
  ]);
}

function schedulerSensitiveFixture(): Event[] {
  return ['a', 'b', 'c', 'd'].flatMap((obligation) => [
    {
      id: obligation + '/claim',
      obligation,
      kind: 'claim' as const,
      resource: 'scheduler/claim',
      parents: [],
    },
    {
      id: obligation + '/effect',
      obligation,
      kind: 'effect' as const,
      resource: 'effect/' + obligation,
      parents: [obligation + '/claim'],
    },
  ]);
}

function futureConflictFixture(): Event[] {
  return [
    { id: 'a/root', obligation: 'a', kind: 'claim', resource: 'root/a', parents: [] },
    { id: 'b/root', obligation: 'b', kind: 'claim', resource: 'root/b', parents: [] },
    {
      id: 'a/effect',
      obligation: 'a',
      kind: 'effect',
      resource: 'shared/x',
      parents: ['a/root'],
      outcome: 'A',
    },
    {
      id: 'b/effect',
      obligation: 'b',
      kind: 'effect',
      resource: 'shared/x',
      parents: ['b/root'],
      outcome: 'B',
    },
  ];
}

function crossObligationEnablerFixture(): Event[] {
  return [
    { id: 'a/root', obligation: 'a', kind: 'claim', resource: 'root/a', parents: [] },
    {
      id: 'a/effect',
      obligation: 'a',
      kind: 'effect',
      resource: 'shared/x',
      parents: ['a/root'],
    },
    { id: 'b/root', obligation: 'b', kind: 'claim', resource: 'root/b', parents: [] },
    {
      id: 'c/effect',
      obligation: 'c',
      kind: 'effect',
      resource: 'shared/x',
      parents: ['b/root'],
    },
  ];
}

function reviewedDporCounterexampleFixture(): Event[] {
  return [
    { id: 'a/claim', obligation: 'a', kind: 'claim', resource: 'provider/y', parents: [] },
    {
      id: 'a/reserve',
      obligation: 'a',
      kind: 'claim',
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
    { id: 'b/root', obligation: 'b', kind: 'claim', resource: 'provider/y', parents: [] },
    {
      id: 'c/effect',
      obligation: 'c',
      kind: 'effect',
      resource: 'provider/x',
      parents: ['b/root'],
    },
  ];
}

function generatedFourEventCorpus() {
  const ids = ['a', 'b', 'c', 'd'];
  const possibleEdges = [
    [1, 0],
    [2, 0],
    [2, 1],
    [3, 0],
    [3, 1],
    [3, 2],
  ] as const;
  let models = 0;
  let exhaustiveExecutions = 0;
  let reducedExecutions = 0;
  let traceClasses = 0;

  for (let edgeMask = 0; edgeMask < 1 << possibleEdges.length; edgeMask += 1) {
    for (let resourceMask = 0; resourceMask < 1 << ids.length; resourceMask += 1) {
      const events: Event[] = ids.map((id, index) => ({
        id,
        obligation: id,
        kind: 'effect',
        resource: (resourceMask & (1 << index)) !== 0 ? 'shared/x' : 'shared/y',
        parents: possibleEdges
          .filter((_, edgeIndex) => (edgeMask & (1 << edgeIndex)) !== 0)
          .filter(([downstream]) => downstream === index)
          .map(([, upstream]) => ids[upstream]!),
      }));
      const result = assertTraceComplete(events);
      models += 1;
      exhaustiveExecutions += result.exhaustive_executions;
      reducedExecutions += result.reduced_executions;
      traceClasses += result.trace_classes;
    }
  }

  assert.equal(models, 1_024);
  return { models, exhaustiveExecutions, reducedExecutions, traceClasses };
}

const independent = assertTraceComplete(independentChainsFixture());
const scheduler = assertTraceComplete(schedulerSensitiveFixture());
const futureConflict = assertTraceComplete(futureConflictFixture());
const crossObligation = assertTraceComplete(crossObligationEnablerFixture());
const reviewedCounterexample = assertTraceComplete(reviewedDporCounterexampleFixture());
const generated = generatedFourEventCorpus();

assert.equal(independent.trace_classes, 1);
assert.equal(independent.reduced_executions, 1);
assert.equal(scheduler.trace_classes, 24);
assert.equal(scheduler.reduced_executions, 24);
assert.equal(futureConflict.trace_classes, 2);
assert.equal(futureConflict.reduced_executions, 2);
assert.equal(crossObligation.trace_classes, 2);
assert.equal(crossObligation.reduced_executions, 2);
assert.equal(reviewedCounterexample.trace_classes, 6);
assert.equal(reviewedCounterexample.reduced_executions, 6);

console.log(JSON.stringify({ kind: 'stubborn-set-independent', ...independent }));
console.log(JSON.stringify({ kind: 'stubborn-set-scheduler', ...scheduler }));
console.log(JSON.stringify({ kind: 'stubborn-set-future-conflict', ...futureConflict }));
console.log(JSON.stringify({ kind: 'stubborn-set-cross-obligation', ...crossObligation }));
console.log(JSON.stringify({ kind: 'stubborn-set-reviewed-counterexample', ...reviewedCounterexample }));
console.log(JSON.stringify({ kind: 'stubborn-set-generated-corpus', ...generated }));
console.log(
  JSON.stringify({
    kind: 'stubborn-set-partial-order-summary',
    result: 'supported',
    generated_models: generated.models,
    independent_trace_classes: independent.trace_classes,
    scheduler_trace_classes: scheduler.trace_classes,
    future_conflict_trace_classes: futureConflict.trace_classes,
    cross_obligation_trace_classes: crossObligation.trace_classes,
    reviewed_counterexample_trace_classes: reviewedCounterexample.trace_classes,
  }),
);
