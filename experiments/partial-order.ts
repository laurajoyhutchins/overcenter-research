export interface PartialOrderEvent {
  id: string;
  parents: readonly string[];
}

export type IndependenceOracle<T extends PartialOrderEvent> = (left: T, right: T) => boolean;

export interface ExplorationResult<T extends PartialOrderEvent> {
  executions: T[][];
  prefixes: number;
  sleep_prunes: number;
}

export function eventMap<T extends PartialOrderEvent>(events: readonly T[]): Map<string, T> {
  return new Map(events.map((event) => [event.id, event]));
}

export function ancestorsOf<T extends PartialOrderEvent>(
  id: string,
  byId: ReadonlyMap<string, T>,
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

export function causalAncestors<T extends PartialOrderEvent>(
  events: readonly T[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const byId = eventMap(events);
  return new Map(events.map((event) => [event.id, ancestorsOf(event.id, byId)]));
}

export function enabledEvents<T extends PartialOrderEvent>(
  events: readonly T[],
  done: ReadonlySet<string>,
  byId: ReadonlyMap<string, T> = eventMap(events),
): T[] {
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

export function enumerateAll<T extends PartialOrderEvent>(
  events: readonly T[],
): ExplorationResult<T> {
  const byId = eventMap(events);
  const executions: T[][] = [];
  let prefixes = 0;

  const visit = (done: Set<string>, sequence: T[]): void => {
    prefixes += 1;
    if (sequence.length === events.length) {
      executions.push([...sequence]);
      return;
    }

    const ready = enabledEvents(events, done, byId);
    if (ready.length === 0) throw new Error('PARTIAL_ORDER_DEAD_END');
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

export function enumerateExecutions<T extends PartialOrderEvent>(events: readonly T[]): T[][] {
  return enumerateAll(events).executions;
}

export function exploreWithSleepSets<T extends PartialOrderEvent>(
  events: readonly T[],
  oracle: IndependenceOracle<T>,
): ExplorationResult<T> {
  const byId = eventMap(events);
  const executions: T[][] = [];
  let prefixes = 0;
  let sleepPrunes = 0;

  const visit = (done: Set<string>, sequence: T[], sleep: ReadonlySet<string>): void => {
    prefixes += 1;
    if (sequence.length === events.length) {
      executions.push([...sequence]);
      return;
    }

    const ready = enabledEvents(events, done, byId);
    if (ready.length === 0) throw new Error('PARTIAL_ORDER_DEAD_END');

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

export function canonicalTrace<T extends PartialOrderEvent>(
  sequence: readonly T[],
  oracle: IndependenceOracle<T>,
): string {
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

  if (normalized.length !== ids.length) throw new Error('TRACE_DEPENDENCY_CYCLE');
  return normalized.join(' ');
}

export function traceKeys<T extends PartialOrderEvent>(
  executions: readonly T[][],
  oracle: IndependenceOracle<T>,
): Set<string> {
  return new Set(executions.map((execution) => canonicalTrace(execution, oracle)));
}
