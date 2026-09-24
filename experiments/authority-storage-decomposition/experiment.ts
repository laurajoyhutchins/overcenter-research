import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FactCommit } from '../../src/authority/facts.ts';
import { KernelCore, runCoreLoop } from '../../src/authority/engine.ts';
import { ComposedFactStore } from '../../src/authority/store.ts';
import { GitOvercenterKernel } from '../../src/storage/git-kernel.ts';
import { DirectoryFactObjects, GitAuthorityHead } from './split-store.ts';

const REF = 'refs/overcenter/state';

const OMIT = new Set([
  'revision',
  'run_id',
  'claimed_revision',
  'claim_commit',
  'execution_authority_commit',
  'execution_capability_sha256',
  'settlement_commit',
  'settled_at',
]);

function normalizedHistory(history: FactCommit[]) {
  const ids = new Map(
    history.map((record, index) => [record.commit, 'commit-' + String(index + 1)]),
  );
  return history.map((record) => ({
    commit: ids.get(record.commit),
    parent: record.parent === null ? null : ids.get(record.parent),
    graph_patch: record.graph_patch ?? null,
    claim: record.claim ?? null,
    execution_authority: record.execution_authority ?? null,
    effect_reservation: record.effect_reservation ?? null,
    effect_release: record.effect_release ?? null,
    receipt: record.receipt ?? null,
  }));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !OMIT.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

function snapshot(kernel: KernelCore) {
  const work = kernel.inspect();
  return normalize({
    work,
    explanations: work.map((item) => kernel.explain(item.id)),
    receipts: kernel.receipts(),
  });
}

function initBare(path: string): void {
  execFileSync('git', ['init', '--bare', '-q', path]);
}

function contractAndOrphanCase(root: string): void {
  const headRepo = join(root, 'contract-head.git');
  const objectsRoot = join(root, 'contract-objects');
  initBare(headRepo);

  const objects = new DirectoryFactObjects(objectsRoot);
  const authority = new GitAuthorityHead(headRepo, REF);
  const store = new ComposedFactStore(objects, authority);

  const initial = store.append(null, 'initialize');
  assert.ok(initial);

  const defined = store.append(initial, 'define a', {
    'graph-patch.json': { schema: 'test-graph-patch', node_id: 'a' },
  });
  assert.ok(defined);

  const stale = store.append(initial, 'stale writer', {
    'claim.json': { schema: 'should-not-land' },
  });
  assert.equal(stale, null);

  const settled = store.append(defined, 'settle a', {
    'receipt.json': { schema: 'test-receipt', run_id: 'run-a' },
  });
  assert.ok(settled);
  assert.equal(store.head(), settled);

  const history = store.history(settled);
  assert.equal(history.length, 3);
  assert.equal(
    history.some(
      (record) => (record.claim as { schema?: string } | null)?.schema === 'should-not-land',
    ),
    false,
  );
  assert.equal(objects.ids().length, 4);

  const referenced = new Set(authority.history(settled).map((record) => record.factId));
  const orphans = objects.ids().filter((id) => !referenced.has(id));
  assert.equal(orphans.length, 1);

  for (const record of authority.history(settled)) {
    assert.deepEqual(authority.treePaths(record.revision), ['fact-id']);
  }

  const replicaRoot = join(root, 'contract-objects-replica');
  cpSync(objectsRoot, replicaRoot, { recursive: true });
  const replica = new ComposedFactStore(
    new DirectoryFactObjects(replicaRoot),
    new GitAuthorityHead(headRepo, REF),
  );
  assert.deepEqual(normalizedHistory(replica.history(settled)), normalizedHistory(history));

  console.log(
    JSON.stringify({
      kind: 'authority-storage-contract',
      authoritative_commits: history.length,
      immutable_objects: objects.ids().length,
      unreachable_objects: orphans.length,
      authority_tree_paths: ['fact-id'],
      replica_replay: 'PASS',
    }),
  );
}

function missingObjectCase(root: string): void {
  const headRepo = join(root, 'missing-head.git');
  const objects = new DirectoryFactObjects(join(root, 'missing-objects'));
  initBare(headRepo);

  const authority = new GitAuthorityHead(headRepo, REF);
  const store = new ComposedFactStore(objects, authority);
  const initial = store.append(null, 'initialize');
  assert.ok(initial);

  const defined = store.append(initial, 'define missing object', {
    'graph-patch.json': { schema: 'missing-object-control/v1' },
  });
  assert.ok(defined);

  const missing = authority.factId(defined);
  objects.removeForNegativeControl(missing);
  assert.throws(() => store.history(defined), /FACT_OBJECT_MISSING/);
  assert.equal(store.head(), defined);

  console.log(
    JSON.stringify({
      kind: 'authority-storage-missing-object',
      outcome: 'FAIL_CLOSED',
    }),
  );
}

async function exerciseKernel(kernel: KernelCore, firstPath: string, secondPath: string) {
  kernel.initialize();
  const revision = kernel.head();
  assert.ok(revision);

  kernel.applyGraphPatch(
    {
      upsert: [
        {
          id: 'second',
          dependencies: [{ kind: 'control', upstream: 'first' }],
          packet: { path: secondPath, content: 'B' },
          postcondition: {
            verifier: 'file-content-equals/v1',
            path: secondPath,
            content: 'B',
          },
        },
        {
          id: 'first',
          packet: { path: firstPath, content: 'A' },
          postcondition: {
            verifier: 'file-content-equals/v1',
            path: firstPath,
            content: 'A',
          },
        },
      ],
    },
    revision,
  );

  const before = snapshot(kernel);
  await runCoreLoop(kernel, {
    effect: async (packet) => {
      writeFileSync(String(packet.path), String(packet.content));
      return { kind: 'ok' };
    },
  });

  return {
    before,
    after: snapshot(kernel),
  };
}

async function kernelDifferentialCase(root: string): Promise<void> {
  const monolithicRepo = join(root, 'monolithic.git');
  const splitHeadRepo = join(root, 'split-head.git');
  const splitObjects = join(root, 'split-objects');
  const firstPath = join(root, 'first.txt');
  const secondPath = join(root, 'second.txt');

  initBare(monolithicRepo);
  initBare(splitHeadRepo);

  const monolithic = new GitOvercenterKernel(monolithicRepo, { ref: REF });
  const splitStore = new ComposedFactStore(
    new DirectoryFactObjects(splitObjects),
    new GitAuthorityHead(splitHeadRepo, REF),
  );
  const split = new KernelCore(splitStore);

  const monolithicResult = await exerciseKernel(monolithic, firstPath, secondPath);
  unlinkSync(firstPath);
  unlinkSync(secondPath);
  const splitResult = await exerciseKernel(split, firstPath, secondPath);

  assert.deepEqual(splitResult.before, monolithicResult.before);
  assert.deepEqual(splitResult.after, monolithicResult.after);

  const splitHead = split.head();
  assert.ok(splitHead);
  for (const record of splitStore.authority.history(splitHead)) {
    assert.deepEqual(splitStore.authority.treePaths(record.revision), ['fact-id']);
  }

  console.log(
    JSON.stringify({
      kind: 'authority-storage-kernel-differential',
      before: 'EQUIVALENT',
      after: 'EQUIVALENT',
      head_payload: 'fact-id-only',
    }),
  );
}

async function raceCase(root: string): Promise<void> {
  const headRepo = join(root, 'race-head.git');
  const objectRoot = join(root, 'race-objects');
  initBare(headRepo);

  const store = new ComposedFactStore(
    new DirectoryFactObjects(objectRoot),
    new GitAuthorityHead(headRepo, REF),
  );
  const initial = store.append(null, 'initialize race');
  assert.ok(initial);

  const fixture = fileURLToPath(new URL('./contender.ts', import.meta.url));
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      (_, index) =>
        new Promise<string | null>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--experimental-strip-types',
              fixture,
              headRepo,
              objectRoot,
              REF,
              initial,
              String(index),
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );

          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
          });
          child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
          });
          child.once('error', reject);
          child.once('close', (code, signal) => {
            if (code !== 0) {
              reject(
                new Error(
                  'contender failed (code=' +
                    String(code) +
                    ', signal=' +
                    String(signal) +
                    '): ' +
                    stderr,
                ),
              );
              return;
            }
            const record = JSON.parse(stdout.trim()) as { commit: string | null };
            resolve(record.commit);
          });
        }),
    ),
  );

  assert.equal(results.filter(Boolean).length, 1);

  const head = store.head();
  assert.ok(head);
  const history = store.history(head);
  assert.equal(history.length, 2);
  assert.equal(history.filter((record) => record.claim !== null).length, 1);

  const referenced = new Set(store.authority.history(head).map((record) => record.factId));
  const objectIds = store.objects.ids();
  const orphans = objectIds.filter((id) => !referenced.has(id));

  assert.equal(objectIds.length, 9);
  assert.equal(orphans.length, 7);

  console.log(
    JSON.stringify({
      kind: 'authority-storage-race',
      contenders: 8,
      winners: 1,
      authoritative_claims: 1,
      immutable_objects: objectIds.length,
      unreachable_loser_objects: orphans.length,
    }),
  );
}

const root = mkdtempSync(join(tmpdir(), 'overcenter-authority-storage-decomposition-'));
try {
  contractAndOrphanCase(root);
  missingObjectCase(root);
  await kernelDifferentialCase(root);
  await raceCase(root);
  console.log(
    JSON.stringify({
      kind: 'authority-storage-decomposition-summary',
      outcome: 'SUPPORTED',
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
