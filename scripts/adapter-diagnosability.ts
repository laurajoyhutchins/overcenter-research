export type MutationReality = 'occurred' | 'not-occurred';

export interface ProtocolState {
  id: string;
  mutation: MutationReality;
}

export interface ProtocolTransition {
  from: string;
  to: string;
  event: string;
  observation?: string;
  consequential?: string;
}

export interface AdapterProtocol {
  id: string;
  initial: string;
  states: readonly ProtocolState[];
  transitions: readonly ProtocolTransition[];
}

export interface ProductStep {
  left: string;
  right: string;
  observation: string | null;
  states: readonly [string, string];
}

export interface DiagnosabilityAnalysis {
  diagnosable: boolean;
  safeDiagnosable: boolean;
  ambiguousPairs: number;
  maxAmbiguousObservableDelay: number | null;
  nonDiagnosableWitness?: readonly ProductStep[];
  unsafeWitness?: {
    pair: readonly [string, string];
    action: string;
    trace: readonly ProductStep[];
  };
}

interface ProductEdge {
  to: string;
  observable: boolean;
  step: ProductStep;
}

function pairKey(left: string, right: string): string {
  return `${left}\0${right}`;
}

function parsePair(key: string): [string, string] {
  const pair = key.split('\0');
  if (pair.length !== 2) throw new Error('INVALID_PRODUCT_PAIR');
  return [pair[0]!, pair[1]!];
}

function indexProtocol(protocol: AdapterProtocol) {
  const states = new Map(protocol.states.map((state) => [state.id, state]));
  const outgoing = protocol.transitions.reduce((map, transition) => {
    map.set(transition.from, [...(map.get(transition.from) ?? []), transition]);
    return map;
  }, new Map<string, ProtocolTransition[]>());
  return { states, outgoing };
}

export function validateAdapterProtocol(protocol: AdapterProtocol): void {
  if (!protocol.id.trim()) throw new Error('ADAPTER_PROTOCOL_ID_REQUIRED');
  if (!protocol.initial.trim()) throw new Error('ADAPTER_PROTOCOL_INITIAL_REQUIRED');
  if (protocol.states.length === 0) throw new Error('ADAPTER_PROTOCOL_STATES_REQUIRED');

  const ids = new Set<string>();
  for (const state of protocol.states) {
    if (!state.id.trim()) throw new Error('ADAPTER_PROTOCOL_STATE_ID_REQUIRED');
    if (ids.has(state.id)) throw new Error(`ADAPTER_PROTOCOL_DUPLICATE_STATE:${state.id}`);
    ids.add(state.id);
  }
  if (!ids.has(protocol.initial)) {
    throw new Error(`ADAPTER_PROTOCOL_INITIAL_UNKNOWN:${protocol.initial}`);
  }

  for (const transition of protocol.transitions) {
    if (!ids.has(transition.from)) {
      throw new Error(`ADAPTER_PROTOCOL_TRANSITION_FROM_UNKNOWN:${transition.from}`);
    }
    if (!ids.has(transition.to)) {
      throw new Error(`ADAPTER_PROTOCOL_TRANSITION_TO_UNKNOWN:${transition.to}`);
    }
    if (!transition.event.trim()) throw new Error('ADAPTER_PROTOCOL_EVENT_REQUIRED');
    if (transition.observation !== undefined && !transition.observation.trim()) {
      throw new Error('ADAPTER_PROTOCOL_OBSERVATION_EMPTY');
    }
    if (transition.consequential !== undefined && !transition.consequential.trim()) {
      throw new Error('ADAPTER_PROTOCOL_CONSEQUENTIAL_EMPTY');
    }
  }
}

function buildProduct(protocol: AdapterProtocol) {
  validateAdapterProtocol(protocol);
  const { states, outgoing } = indexProtocol(protocol);
  const start = pairKey(protocol.initial, protocol.initial);
  const seen = new Set([start]);
  const queue = [start];
  const edges = new Map<string, ProductEdge[]>();
  const predecessor = new Map<string, { from: string; step: ProductStep }>();

  const differs = (key: string): boolean => {
    const [left, right] = parsePair(key);
    return states.get(left)!.mutation !== states.get(right)!.mutation;
  };

  while (queue.length > 0) {
    const current = queue.shift()!;
    const [leftState, rightState] = parsePair(current);
    const leftOutgoing = outgoing.get(leftState) ?? [];
    const rightOutgoing = outgoing.get(rightState) ?? [];
    const next: ProductEdge[] = [];

    for (const transition of leftOutgoing.filter((item) => item.observation === undefined)) {
      next.push({
        to: pairKey(transition.to, rightState),
        observable: false,
        step: {
          left: transition.event,
          right: 'ε',
          observation: null,
          states: [transition.to, rightState],
        },
      });
    }

    for (const transition of rightOutgoing.filter((item) => item.observation === undefined)) {
      next.push({
        to: pairKey(leftState, transition.to),
        observable: false,
        step: {
          left: 'ε',
          right: transition.event,
          observation: null,
          states: [leftState, transition.to],
        },
      });
    }

    for (const left of leftOutgoing.filter((item) => item.observation !== undefined)) {
      for (const right of rightOutgoing.filter(
        (item) => item.observation === left.observation,
      )) {
        next.push({
          to: pairKey(left.to, right.to),
          observable: true,
          step: {
            left: left.event,
            right: right.event,
            observation: left.observation!,
            states: [left.to, right.to],
          },
        });
      }
    }

    edges.set(current, next);
    for (const edge of next) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      predecessor.set(edge.to, { from: current, step: edge.step });
      queue.push(edge.to);
    }
  }

  const pathTo = (target: string): ProductStep[] => {
    const path: ProductStep[] = [];
    let current = target;
    while (current !== start) {
      const previous = predecessor.get(current);
      if (!previous) break;
      path.push(previous.step);
      current = previous.from;
    }
    return path.reverse();
  };

  return { start, seen, edges, outgoing, differs, pathTo };
}

function findAmbiguousCycle(product: ReturnType<typeof buildProduct>) {
  const ambiguous = [...product.seen].filter(product.differs);
  const allowed = new Set(ambiguous);

  for (const start of ambiguous) {
    const stack = [{ at: start, path: [] as ProductEdge[], visited: new Set([start]) }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const edge of product.edges.get(current.at) ?? []) {
        if (!allowed.has(edge.to)) continue;
        if (edge.to === start) return { entry: start, path: [...current.path, edge] };
        if (current.visited.has(edge.to)) continue;
        stack.push({
          at: edge.to,
          path: [...current.path, edge],
          visited: new Set([...current.visited, edge.to]),
        });
      }
    }
  }

  return null;
}

function maxAmbiguousDelay(product: ReturnType<typeof buildProduct>): number {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (state: string): number => {
    const known = memo.get(state);
    if (known !== undefined) return known;
    if (visiting.has(state)) throw new Error('ADAPTER_PROTOCOL_UNEXPECTED_AMBIGUOUS_CYCLE');
    visiting.add(state);

    let best = 0;
    for (const edge of product.edges.get(state) ?? []) {
      if (!product.differs(edge.to)) continue;
      best = Math.max(best, Number(edge.observable) + visit(edge.to));
    }

    visiting.delete(state);
    memo.set(state, best);
    return best;
  };

  return Math.max(0, ...[...product.seen].filter(product.differs).map(visit));
}

export function analyzeAdapterProtocol(protocol: AdapterProtocol): DiagnosabilityAnalysis {
  const product = buildProduct(protocol);
  const ambiguous = [...product.seen].filter(product.differs);
  const cycle = findAmbiguousCycle(product);

  let unsafeWitness: DiagnosabilityAnalysis['unsafeWitness'];
  for (const key of ambiguous) {
    const [left, right] = parsePair(key);
    const transition = [
      ...(product.outgoing.get(left) ?? []),
      ...(product.outgoing.get(right) ?? []),
    ].find((candidate) => candidate.consequential);

    if (transition?.consequential) {
      unsafeWitness = {
        pair: [left, right],
        action: transition.consequential,
        trace: product.pathTo(key),
      };
      break;
    }
  }

  return {
    diagnosable: cycle === null,
    safeDiagnosable: cycle === null && unsafeWitness === undefined,
    ambiguousPairs: ambiguous.length,
    maxAmbiguousObservableDelay: cycle === null ? maxAmbiguousDelay(product) : null,
    ...(cycle
      ? {
          nonDiagnosableWitness: [
            ...product.pathTo(cycle.entry),
            ...cycle.path.map((edge) => edge.step),
          ],
        }
      : {}),
    ...(unsafeWitness === undefined ? {} : { unsafeWitness }),
  };
}

export function boundedAmbiguousObservationSequences(
  protocol: AdapterProtocol,
  depth = 12,
): number {
  if (!Number.isSafeInteger(depth) || depth < 1) {
    throw new Error('ADAPTER_PROTOCOL_ORACLE_DEPTH_INVALID');
  }
  validateAdapterProtocol(protocol);
  const { states, outgoing } = indexProtocol(protocol);
  let traces = [{ state: protocol.initial, observations: [] as string[] }];

  for (let index = 0; index < depth; index += 1) {
    traces = traces.flatMap((trace) =>
      (outgoing.get(trace.state) ?? []).map((transition) => ({
        state: transition.to,
        observations:
          transition.observation === undefined
            ? trace.observations
            : [...trace.observations, transition.observation],
      })),
    );
  }

  const groups = new Map<string, Set<MutationReality>>();
  for (const trace of traces) {
    const key = JSON.stringify(trace.observations);
    const realities = groups.get(key) ?? new Set<MutationReality>();
    realities.add(states.get(trace.state)!.mutation);
    groups.set(key, realities);
  }

  return [...groups.values()].filter((realities) => realities.size > 1).length;
}

export function releaseDecision(
  analysis: DiagnosabilityAnalysis,
): 'safe-to-release' | 'ambiguous-do-not-release' {
  return analysis.safeDiagnosable ? 'safe-to-release' : 'ambiguous-do-not-release';
}
