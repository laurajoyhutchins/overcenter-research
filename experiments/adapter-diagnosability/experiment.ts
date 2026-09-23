import assert from 'node:assert/strict';

type Mutation = 'occurred' | 'not-occurred';
type Action = 'retry' | 'release-authority' | 'settle-done';
type State = { id: string; mutation: Mutation };
type Transition = {
  from: string;
  to: string;
  event: string;
  observation?: string;
  consequential?: Action;
};
type Protocol = { id: string; initial: string; states: State[]; transitions: Transition[] };
type Step = {
  left: string;
  right: string;
  observation: string | null;
  states: [string, string];
};
type Edge = { to: string; observable: boolean; step: Step };

const S = (id: string, mutation: Mutation): State => ({ id, mutation });
const T = (
  from: string,
  to: string,
  event: string,
  observation?: string,
  consequential?: Action,
): Transition => ({
  from,
  to,
  event,
  ...(observation === undefined ? {} : { observation }),
  ...(consequential === undefined ? {} : { consequential }),
});
const key = (a: string, b: string) => `${a}\0${b}`;
const pair = (k: string) => k.split('\0') as [string, string];
const index = (p: Protocol) => ({
  states: new Map(p.states.map((s) => [s.id, s])),
  out: p.transitions.reduce(
    (m, t) => m.set(t.from, [...(m.get(t.from) ?? []), t]),
    new Map<string, Transition[]>(),
  ),
});

function product(p: Protocol) {
  const { states, out } = index(p);
  const start = key(p.initial, p.initial);
  const seen = new Set([start]);
  const queue = [start];
  const edges = new Map<string, Edge[]>();
  const predecessor = new Map<string, { from: string; step: Step }>();
  const differs = (k: string) => {
    const [a, b] = pair(k);
    return states.get(a)!.mutation !== states.get(b)!.mutation;
  };

  while (queue.length) {
    const here = queue.shift()!;
    const [a, b] = pair(here);
    const ao = out.get(a) ?? [];
    const bo = out.get(b) ?? [];
    const next: Edge[] = [];
    for (const t of ao.filter((x) => x.observation === undefined))
      next.push({
        to: key(t.to, b),
        observable: false,
        step: { left: t.event, right: 'ε', observation: null, states: [t.to, b] },
      });
    for (const t of bo.filter((x) => x.observation === undefined))
      next.push({
        to: key(a, t.to),
        observable: false,
        step: { left: 'ε', right: t.event, observation: null, states: [a, t.to] },
      });
    for (const l of ao.filter((x) => x.observation !== undefined))
      for (const r of bo.filter((x) => x.observation === l.observation))
        next.push({
          to: key(l.to, r.to),
          observable: true,
          step: {
            left: l.event,
            right: r.event,
            observation: l.observation!,
            states: [l.to, r.to],
          },
        });
    edges.set(here, next);
    for (const edge of next)
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        predecessor.set(edge.to, { from: here, step: edge.step });
        queue.push(edge.to);
      }
  }

  const pathTo = (target: string) => {
    const path: Step[] = [];
    for (let cur = target; cur !== start; ) {
      const prev = predecessor.get(cur);
      if (!prev) break;
      path.push(prev.step);
      cur = prev.from;
    }
    return path.reverse();
  };
  return { start, seen, edges, out, differs, pathTo };
}

function ambiguousCycle(g: ReturnType<typeof product>) {
  const ambiguous = [...g.seen].filter(g.differs);
  const allowed = new Set(ambiguous);
  for (const start of ambiguous) {
    const stack = [{ at: start, path: [] as Edge[], visited: new Set([start]) }];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of g.edges.get(cur.at) ?? []) {
        if (!allowed.has(e.to)) continue;
        if (e.to === start) return { entry: start, path: [...cur.path, e] };
        if (!cur.visited.has(e.to))
          stack.push({
            at: e.to,
            path: [...cur.path, e],
            visited: new Set([...cur.visited, e.to]),
          });
      }
    }
  }
  return null;
}

function maxAmbiguousDelay(g: ReturnType<typeof product>) {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const dfs = (at: string): number => {
    if (memo.has(at)) return memo.get(at)!;
    if (visiting.has(at)) throw new Error('unexpected ambiguous cycle');
    visiting.add(at);
    let best = 0;
    for (const e of g.edges.get(at) ?? [])
      if (g.differs(e.to)) best = Math.max(best, Number(e.observable) + dfs(e.to));
    visiting.delete(at);
    memo.set(at, best);
    return best;
  };
  return Math.max(0, ...[...g.seen].filter(g.differs).map(dfs));
}

function analyze(p: Protocol) {
  const g = product(p);
  const ambiguous = [...g.seen].filter(g.differs);
  const cycle = ambiguousCycle(g);
  let unsafe: { pair: [string, string]; action: Action } | undefined;
  for (const k of ambiguous) {
    const [a, b] = pair(k);
    const t = [...(g.out.get(a) ?? []), ...(g.out.get(b) ?? [])].find((x) => x.consequential);
    if (t?.consequential) {
      unsafe = { pair: [a, b], action: t.consequential };
      break;
    }
  }
  return {
    diagnosable: !cycle,
    safeDiagnosable: !cycle && !unsafe,
    ambiguousPairs: ambiguous.length,
    maxAmbiguousObservableDelay: cycle ? null : maxAmbiguousDelay(g),
    nonDiagnosableWitness: cycle
      ? [...g.pathTo(cycle.entry), ...cycle.path.map((e) => e.step)]
      : undefined,
    unsafeWitness: unsafe,
  };
}

function oracle(p: Protocol, depth = 12) {
  const { states, out } = index(p);
  let traces = [{ state: p.initial, observations: [] as string[] }];
  for (let i = 0; i < depth; i++)
    traces = traces.flatMap((trace) =>
      (out.get(trace.state) ?? []).map((t) => ({
        state: t.to,
        observations:
          t.observation === undefined ? trace.observations : [...trace.observations, t.observation],
      })),
    );
  const groups = new Map<string, Set<Mutation>>();
  for (const trace of traces) {
    const k = JSON.stringify(trace.observations);
    const values = groups.get(k) ?? new Set<Mutation>();
    values.add(states.get(trace.state)!.mutation);
    groups.set(k, values);
  }
  return [...groups.values()].filter((x) => x.size > 1).length;
}

const protocols: Protocol[] = [
  {
    id: 'undispatched',
    initial: 's',
    states: [S('s', 'not-occurred'), S('n', 'not-occurred')],
    transitions: [T('s', 'n', 'connect-failed', 'CONNECT_FAILED'), T('n', 'n', 'idle', 'IDLE')],
  },
  {
    id: 'ambiguous-timeout',
    initial: 's',
    states: [
      S('s', 'not-occurred'),
      S('c', 'occurred'),
      S('r', 'not-occurred'),
      S('m', 'occurred'),
      S('n', 'not-occurred'),
    ],
    transitions: [
      T('s', 'c', 'commit'),
      T('s', 'r', 'reject'),
      T('c', 'm', 'reset', 'TIMEOUT'),
      T('r', 'n', 'reset', 'TIMEOUT'),
      T('m', 'm', 'poll', 'NO_EVIDENCE'),
      T('n', 'n', 'poll', 'NO_EVIDENCE'),
    ],
  },
  {
    id: 'receipt',
    initial: 's',
    states: [
      S('s', 'not-occurred'),
      S('c', 'occurred'),
      S('r', 'not-occurred'),
      S('ma', 'occurred'),
      S('na', 'not-occurred'),
      S('md', 'occurred'),
      S('nd', 'not-occurred'),
    ],
    transitions: [
      T('s', 'c', 'commit'),
      T('s', 'r', 'reject'),
      T('c', 'ma', 'reset', 'TIMEOUT'),
      T('r', 'na', 'reset', 'TIMEOUT'),
      T('ma', 'md', 'receipt', 'RECEIPT_PRESENT'),
      T('na', 'nd', 'receipt', 'RECEIPT_ABSENT'),
      T('md', 'md', 'idle', 'IDLE'),
      T('nd', 'nd', 'idle', 'IDLE'),
    ],
  },
  {
    id: 'stale-get',
    initial: 's',
    states: [
      S('s', 'not-occurred'),
      S('c', 'occurred'),
      S('r', 'not-occurred'),
      S('m', 'occurred'),
      S('n', 'not-occurred'),
    ],
    transitions: [
      T('s', 'c', 'commit'),
      T('s', 'r', 'reject'),
      T('c', 'm', 'reset', 'TIMEOUT'),
      T('r', 'n', 'reset', 'TIMEOUT'),
      T('m', 'm', 'get-stale', 'GET_PRESTATE'),
      T('n', 'n', 'get-current', 'GET_PRESTATE'),
    ],
  },
  {
    id: 'bounded-eventual-webhook',
    initial: 's',
    states: [
      S('s', 'not-occurred'),
      S('c', 'occurred'),
      S('r', 'not-occurred'),
      S('m0', 'occurred'),
      S('n0', 'not-occurred'),
      S('m1', 'occurred'),
      S('n1', 'not-occurred'),
      S('md', 'occurred'),
      S('nd', 'not-occurred'),
    ],
    transitions: [
      T('s', 'c', 'commit'),
      T('s', 'r', 'reject'),
      T('c', 'm0', 'reset', 'TIMEOUT'),
      T('r', 'n0', 'reset', 'TIMEOUT'),
      T('m0', 'm1', 'poll', 'NO_WEBHOOK'),
      T('n0', 'n1', 'poll', 'NO_WEBHOOK'),
      T('m1', 'md', 'webhook', 'WEBHOOK_COMMITTED'),
      T('n1', 'nd', 'window-closes', 'WEBHOOK_ABSENT'),
      T('md', 'md', 'idle', 'IDLE'),
      T('nd', 'nd', 'idle', 'IDLE'),
    ],
  },
  {
    id: 'too-late',
    initial: 's',
    states: [
      S('s', 'not-occurred'),
      S('c', 'occurred'),
      S('r', 'not-occurred'),
      S('ma', 'occurred'),
      S('na', 'not-occurred'),
      S('mr', 'occurred'),
      S('nr', 'not-occurred'),
      S('md', 'occurred'),
      S('nd', 'not-occurred'),
    ],
    transitions: [
      T('s', 'c', 'commit'),
      T('s', 'r', 'reject'),
      T('c', 'ma', 'reset', 'TIMEOUT'),
      T('r', 'na', 'reset', 'TIMEOUT'),
      T('ma', 'mr', 'release', 'RELEASED', 'release-authority'),
      T('na', 'nr', 'release', 'RELEASED', 'release-authority'),
      T('mr', 'md', 'receipt', 'RECEIPT_PRESENT'),
      T('nr', 'nd', 'receipt', 'RECEIPT_ABSENT'),
      T('md', 'md', 'idle', 'IDLE'),
      T('nd', 'nd', 'idle', 'IDLE'),
    ],
  },
  {
    id: 'same-final-state',
    initial: 's',
    states: [
      S('s', 'not-occurred'),
      S('c', 'occurred'),
      S('r', 'not-occurred'),
      S('m', 'occurred'),
      S('n', 'not-occurred'),
    ],
    transitions: [
      T('s', 'c', 'idempotent-write'),
      T('s', 'r', 'no-write'),
      T('c', 'm', 'get', 'GET_DESIRED'),
      T('r', 'n', 'get', 'GET_DESIRED'),
      T('m', 'm', 'get', 'GET_DESIRED'),
      T('n', 'n', 'get', 'GET_DESIRED'),
    ],
  },

  // Production-boundary falsifier, added only after the original seven-fixture
  // corpus passed hosted exact-head evaluation at 79c666d1aad67ff3c7df894f3cd509d572e4fcce.
  // These slices encode the independently established GitHub commit-status
  // transport boundary without changing the diagnoser.
  {
    id: 'github-status-pre-secure-connect',
    initial: 's',
    states: [S('s', 'not-occurred'), S('n', 'not-occurred'), S('r', 'not-occurred')],
    transitions: [
      T(
        's',
        'n',
        'fresh-https-fails-before-secureConnect',
        'GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED',
      ),
      T('n', 'r', 'release-reservation', 'RELEASED', 'release-authority'),
      T('r', 'r', 'idle', 'IDLE'),
    ],
  },
  {
    id: 'github-status-post-secure-connect-reset',
    initial: 's',
    states: [
      S('s', 'not-occurred'),
      S('c', 'occurred'),
      S('n', 'not-occurred'),
      S('ma', 'occurred'),
      S('na', 'not-occurred'),
      S('mr', 'occurred'),
      S('nr', 'not-occurred'),
    ],
    transitions: [
      T('s', 'c', 'remote-commit'),
      T('s', 'n', 'remote-no-commit'),
      T('c', 'ma', 'post-secureConnect-reset', 'GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN'),
      T('n', 'na', 'post-secureConnect-reset', 'GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN'),
      T('ma', 'mr', 'release-reservation', 'RELEASED', 'release-authority'),
      T('na', 'nr', 'release-reservation', 'RELEASED', 'release-authority'),
      T('mr', 'mr', 'readback', 'NO_AUTHORITATIVE_EVIDENCE'),
      T('nr', 'nr', 'readback', 'NO_AUTHORITATIVE_EVIDENCE'),
    ],
  },
  {
    id: 'github-status-http-502',
    initial: 's',
    states: [
      S('s', 'not-occurred'),
      S('c', 'occurred'),
      S('n', 'not-occurred'),
      S('ma', 'occurred'),
      S('na', 'not-occurred'),
      S('mr', 'occurred'),
      S('nr', 'not-occurred'),
    ],
    transitions: [
      T('s', 'c', 'remote-commit'),
      T('s', 'n', 'remote-no-commit'),
      T('c', 'ma', 'http-response', 'GITHUB_STATUS_MUTATION_FAILED:502'),
      T('n', 'na', 'http-response', 'GITHUB_STATUS_MUTATION_FAILED:502'),
      T('ma', 'mr', 'release-reservation', 'RELEASED', 'release-authority'),
      T('na', 'nr', 'release-reservation', 'RELEASED', 'release-authority'),
      T('mr', 'mr', 'readback', 'NO_AUTHORITATIVE_EVIDENCE'),
      T('nr', 'nr', 'readback', 'NO_AUTHORITATIVE_EVIDENCE'),
    ],
  },
];

const expected: Record<string, [boolean, boolean]> = {
  undispatched: [true, true],
  'ambiguous-timeout': [false, false],
  receipt: [true, true],
  'stale-get': [false, false],
  'bounded-eventual-webhook': [true, true],
  'too-late': [true, false],
  'same-final-state': [false, false],
  'github-status-pre-secure-connect': [true, true],
  'github-status-post-secure-connect-reset': [false, false],
  'github-status-http-502': [false, false],
};
const results = protocols.map((p) => {
  const result = analyze(p);
  const ambiguousAt12 = oracle(p);
  assert.deepEqual(
    [result.diagnosable, result.safeDiagnosable],
    expected[p.id],
    `${p.id}: classification`,
  );
  assert.equal(ambiguousAt12 > 0, !result.diagnosable, `${p.id}: independent oracle disagreement`);
  if (!result.diagnosable)
    assert.ok(result.nonDiagnosableWitness?.length, `${p.id}: missing witness`);
  return { protocol: p.id, ...result, depth12AmbiguousSequences: ambiguousAt12 };
});

const resultByProtocol = new Map(results.map((result) => [result.protocol, result]));
const githubStatusBoundary = {
  preSecureConnect: resultByProtocol.get('github-status-pre-secure-connect')?.safeDiagnosable
    ? 'safe-to-release'
    : 'ambiguous-do-not-release',
  postSecureConnectReset: resultByProtocol.get('github-status-post-secure-connect-reset')
    ?.safeDiagnosable
    ? 'safe-to-release'
    : 'ambiguous-do-not-release',
  http502: resultByProtocol.get('github-status-http-502')?.safeDiagnosable
    ? 'safe-to-release'
    : 'ambiguous-do-not-release',
};
assert.deepEqual(githubStatusBoundary, {
  preSecureConnect: 'safe-to-release',
  postSecureConnectReset: 'ambiguous-do-not-release',
  http502: 'ambiguous-do-not-release',
});
const receipt = protocols.find((p) => p.id === 'receipt')!;
const uncorrelated: Protocol = {
  ...receipt,
  id: 'uncorrelated-receipt',
  transitions: receipt.transitions.map((t) =>
    t.observation?.startsWith('RECEIPT_') ? { ...t, observation: 'RECEIPT' } : t,
  ),
};
assert.equal(analyze(uncorrelated).diagnosable, false, 'negative control survived');
console.log(
  JSON.stringify(
    {
      experiment: 'adapter-diagnosability',
      classifications: results,
      githubStatusBoundary,
      negativeControls: { uncorrelatedReceipt: 'KILLED' },
    },
    null,
    2,
  ),
);
