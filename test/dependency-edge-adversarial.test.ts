import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../src/git-kernel.ts';

type Edge =
  | { kind: 'control'; upstream: string }
  | {
      kind: 'semantic';
      upstream: string;
      consumes:
        | { kind: 'output'; selector: string }
        | { kind: 'evidence'; selector: string };
    };

const pc = (path: string, content: string) => ({
  verifier: 'file-content-equals/v1' as const,
  path,
  content,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-edge-adversarial-'));
  const repo = join(root, 'authority.git');
  execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
  const kernel = new GitOvercenterKernel(repo);
  kernel.initialize();
  return { root, repo, kernel, path: (name: string) => join(root, name) };
}

function defineWithEdges(
  kernel: GitOvercenterKernel,
  {
    id,
    edges = [],
    packet = {},
    postcondition,
  }: {
    id: string;
    edges?: Edge[];
    packet?: Record<string, unknown>;
    postcondition: ReturnType<typeof pc>;
  },
) {
  // Feed the proposed typed representation while also supplying legacy deps so
  // today's kernel still enforces predecessor ordering. The adversarial tests
  // therefore fail on edge semantics, not merely because scheduling vanished.
  return kernel.define({
    id,
    deps: edges.map(edge => edge.upstream),
    packet,
    postcondition,
    dependencies: edges,
  } as Parameters<GitOvercenterKernel['define']>[0]);
}

function settleFile(
  kernel: GitOvercenterKernel,
  id: string,
  path: string,
  content: string,
) {
  const ready = kernel.inspect().find(work => work.id === id);
  assert.ok(ready);
  assert.equal(ready.status, 'READY');
  const run = kernel.claim(id, ready.revision);
  writeFileSync(path, content);
  const receipt = kernel.resolve(run.id);
  assert.equal(receipt.disposition, 'DONE');
  return { run, receipt };
}

function obligationFact(repo: string, commit: string) {
  return JSON.parse(
    execFileSync(
      'git',
      ['-C', repo, 'show', `${commit}:obligation.json`],
      { encoding: 'utf8' },
    ),
  ) as {
    obligation: Record<string, unknown>;
    kind: string;
    previous_definition_commit?: string;
  };
}

test('control dependency changes executability but does not poison downstream semantic identity', () => {
  const f = fixture();
  try {
    const a = f.path('a');
    const b = f.path('b');

    defineWithEdges(f.kernel, {
      id: 'a',
      postcondition: pc(a, 'A1'),
    });
    defineWithEdges(f.kernel, {
      id: 'b',
      edges: [{ kind: 'control', upstream: 'a' }],
      postcondition: pc(b, 'B'),
    });

    settleFile(f.kernel, 'a', a, 'A1');
    const b1 = settleFile(f.kernel, 'b', b, 'B');
    const bReceiptCount = f.kernel.receipts(b1.run.id).length;

    assert.doesNotThrow(() => f.kernel.amend({
      id: 'a',
      postcondition: pc(a, 'A2'),
    }, f.kernel.head()!));

    const projectedB = f.kernel.inspect().find(work => work.id === 'b')!;
    assert.equal(projectedB.status, 'DONE');
    assert.equal(f.kernel.receipts(b1.run.id).length, bReceiptCount);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('semantic dependency invalidates downstream when consumed output identity changes', () => {
  const f = fixture();
  try {
    const a = f.path('a');
    const b = f.path('b');

    defineWithEdges(f.kernel, {
      id: 'a',
      postcondition: pc(a, 'A1'),
    });
    defineWithEdges(f.kernel, {
      id: 'b',
      edges: [{
        kind: 'semantic',
        upstream: 'a',
        consumes: { kind: 'output', selector: 'verified-content' },
      }],
      postcondition: pc(b, 'B'),
    });

    settleFile(f.kernel, 'a', a, 'A1');
    settleFile(f.kernel, 'b', b, 'B');

    f.kernel.amend({
      id: 'a',
      postcondition: pc(a, 'A2'),
    }, f.kernel.head()!);
    settleFile(f.kernel, 'a', a, 'A2');

    const projectedB = f.kernel.inspect().find(work => work.id === 'b')!;
    assert.equal(projectedB.status, 'READY');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('semantic dependency does not invalidate downstream when selected output identity is unchanged', () => {
  const f = fixture();
  try {
    const a = f.path('a');
    const b = f.path('b');

    defineWithEdges(f.kernel, {
      id: 'a',
      packet: { producer: 'v1' },
      postcondition: pc(a, 'same-output'),
    });
    defineWithEdges(f.kernel, {
      id: 'b',
      edges: [{
        kind: 'semantic',
        upstream: 'a',
        consumes: { kind: 'output', selector: 'verified-content' },
      }],
      postcondition: pc(b, 'B'),
    });

    settleFile(f.kernel, 'a', a, 'same-output');
    const b1 = settleFile(f.kernel, 'b', b, 'B');

    f.kernel.amend({
      id: 'a',
      packet: { producer: 'v2' },
      postcondition: pc(a, 'same-output'),
    }, f.kernel.head()!);
    settleFile(f.kernel, 'a', a, 'same-output');

    const projectedB = f.kernel.inspect().find(work => work.id === 'b')!;
    assert.equal(projectedB.status, 'DONE');
    assert.equal(
      f.kernel.receipts(b1.run.id).at(-1)?.settlement_commit,
      b1.receipt.settlement_commit,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('invalidation propagation stops when an intermediary exposes the same selected identity', () => {
  const f = fixture();
  try {
    const a = f.path('a');
    const b = f.path('b');
    const c = f.path('c');

    defineWithEdges(f.kernel, {
      id: 'a',
      packet: { producer: 'v1' },
      postcondition: pc(a, 'same-a-output'),
    });
    defineWithEdges(f.kernel, {
      id: 'b',
      edges: [{
        kind: 'semantic',
        upstream: 'a',
        consumes: { kind: 'output', selector: 'verified-content' },
      }],
      postcondition: pc(b, 'stable-b-output'),
    });
    defineWithEdges(f.kernel, {
      id: 'c',
      edges: [{
        kind: 'semantic',
        upstream: 'b',
        consumes: { kind: 'output', selector: 'verified-content' },
      }],
      postcondition: pc(c, 'C'),
    });

    settleFile(f.kernel, 'a', a, 'same-a-output');
    settleFile(f.kernel, 'b', b, 'stable-b-output');
    const c1 = settleFile(f.kernel, 'c', c, 'C');

    f.kernel.amend({
      id: 'a',
      packet: { producer: 'v2' },
      postcondition: pc(a, 'same-a-output'),
    }, f.kernel.head()!);
    settleFile(f.kernel, 'a', a, 'same-a-output');

    const current = new Map(f.kernel.inspect().map(work => [work.id, work]));
    assert.equal(current.get('b')?.status, 'DONE');
    assert.equal(current.get('c')?.status, 'DONE');
    assert.equal(
      f.kernel.receipts(c1.run.id).at(-1)?.settlement_commit,
      c1.receipt.settlement_commit,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('semantic selector is part of durable edge meaning', () => {
  const f = fixture();
  try {
    const a = f.path('a');
    const b = f.path('b');

    defineWithEdges(f.kernel, {
      id: 'a',
      postcondition: pc(a, 'A'),
    });
    const bDefinition = defineWithEdges(f.kernel, {
      id: 'b',
      edges: [{
        kind: 'semantic',
        upstream: 'a',
        consumes: { kind: 'evidence', selector: 'settlement-receipt' },
      }],
      postcondition: pc(b, 'B'),
    });

    const fact = obligationFact(f.repo, bDefinition);
    const stored = fact.obligation as {
      dependencies?: Edge[];
    };
    assert.deepEqual(stored.dependencies, [{
      kind: 'semantic',
      upstream: 'a',
      consumes: { kind: 'evidence', selector: 'settlement-receipt' },
    }]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('reclassifying control dependency as semantic cannot reuse old completion silently', () => {
  const f = fixture();
  try {
    const a = f.path('a');
    const b = f.path('b');

    defineWithEdges(f.kernel, {
      id: 'a',
      postcondition: pc(a, 'A'),
    });
    defineWithEdges(f.kernel, {
      id: 'b',
      edges: [{ kind: 'control', upstream: 'a' }],
      postcondition: pc(b, 'B'),
    });

    settleFile(f.kernel, 'a', a, 'A');
    settleFile(f.kernel, 'b', b, 'B');

    const amended = f.kernel.amend({
      id: 'b',
      deps: ['a'],
      postcondition: pc(b, 'B'),
      dependencies: [{
        kind: 'semantic',
        upstream: 'a',
        consumes: { kind: 'evidence', selector: 'settlement-receipt' },
      }],
    } as Parameters<GitOvercenterKernel['amend']>[0], f.kernel.head()!);

    const fact = obligationFact(f.repo, amended);
    assert.deepEqual(
      (fact.obligation as { dependencies?: Edge[] }).dependencies,
      [{
        kind: 'semantic',
        upstream: 'a',
        consumes: { kind: 'evidence', selector: 'settlement-receipt' },
      }],
    );
    assert.equal(
      f.kernel.inspect().find(work => work.id === 'b')?.status,
      'READY',
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('undeclared hidden dependency remains outside the derivation model', () => {
  const f = fixture();
  try {
    const declared = f.path('declared');
    const hidden = f.path('hidden');

    defineWithEdges(f.kernel, {
      id: 'x',
      postcondition: pc(declared, 'declared'),
    });
    settleFile(f.kernel, 'x', declared, 'declared');

    const before = JSON.stringify(f.kernel.inspect());
    writeFileSync(hidden, 'ambient-state-changed');
    const after = JSON.stringify(f.kernel.inspect());

    assert.equal(after, before);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('active exact run fences amendment even when edge semantics are otherwise valid', () => {
  const f = fixture();
  try {
    const a = f.path('a');
    defineWithEdges(f.kernel, {
      id: 'a',
      postcondition: pc(a, 'A1'),
    });

    const ready = f.kernel.deriveReadyWork()!;
    f.kernel.claim('a', ready.revision);

    assert.throws(
      () => f.kernel.amend({
        id: 'a',
        postcondition: pc(a, 'A2'),
      }, f.kernel.head()!),
      /PROJECT_BUSY|AMEND_WHILE_IN_FLIGHT/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
