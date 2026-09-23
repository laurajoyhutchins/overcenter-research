import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileEvidenceStore } from '../../src/evidence/file-store.ts';
import {
  evidenceRef,
  validateEvidenceRef,
  type EvidenceRef,
} from '../../src/evidence/reference.ts';
import { SqliteFactStore } from '../../src/storage/sqlite.ts';

interface ReferenceFact {
  schema: 'overcenter-evidence-reference';
  label: string;
  ref: EvidenceRef;
}

function payload(variant: string): Buffer {
  return Buffer.from(`evidence:${variant}:` + 'x'.repeat(256 * 1024));
}

function initialize(database: string): string {
  const store = new SqliteFactStore(database);
  try {
    const head = store.append(null, 'overcenter: initialize');
    assert.ok(head);
    return head;
  } finally {
    store.close();
  }
}

function authorityHead(database: string): string | null {
  const store = new SqliteFactStore(database);
  try {
    return store.head();
  } finally {
    store.close();
  }
}

function verifyHistory(database: string): void {
  const store = new SqliteFactStore(database);
  try {
    const head = store.head();
    assert.ok(head);
    assert.ok(store.history(head).length >= 1);
  } finally {
    store.close();
  }
}

function referenceFacts(database: string): ReferenceFact[] {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT files_json FROM fact_commits ORDER BY sequence')
      .all() as unknown as Array<{ files_json: string }>;
    const facts: ReferenceFact[] = [];
    for (const row of rows) {
      const files = JSON.parse(row.files_json) as Record<string, unknown>;
      const raw = files['evidence-ref.json'];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      if (item.schema !== 'overcenter-evidence-reference') {
        throw new Error('INVALID_REFERENCE_FACT');
      }
      if (typeof item.label !== 'string') throw new Error('INVALID_REFERENCE_LABEL');
      facts.push({
        schema: 'overcenter-evidence-reference',
        label: item.label,
        ref: validateEvidenceRef(item.ref),
      });
    }
    return facts;
  } finally {
    db.close();
  }
}

function worker(
  database: string,
  evidenceRoot: string,
  expectedHead: string,
  variant: string,
  phase = 'none',
) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'experiments/evidence-reference-publication/worker.ts',
      database,
      evidenceRoot,
      expectedHead,
      variant,
      phase,
    ],
    { encoding: 'utf8' },
  );
}

function concurrentWorker(
  database: string,
  evidenceRoot: string,
  expectedHead: string,
  variant: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        'experiments/evidence-reference-publication/worker.ts',
        database,
        evidenceRoot,
        expectedHead,
        variant,
        'none',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function sweepUnreferenced(evidenceRoot: string, live: Set<string>): number {
  let removed = 0;
  for (const shard of readdirSync(evidenceRoot, { withFileTypes: true })) {
    if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
    const directory = join(evidenceRoot, shard.name);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f]{62}$/.test(entry.name)) continue;
      const digest = shard.name + entry.name;
      if (live.has(digest)) continue;
      unlinkSync(join(directory, entry.name));
      removed += 1;
    }
  }
  return removed;
}

test('evidence-first publication makes every crash state recoverable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-reference-publication-'));
  try {
    {
      const database = join(root, 'before-authority.sqlite');
      const evidenceRoot = join(root, 'before-authority-evidence');
      const initial = initialize(database);
      const result = worker(database, evidenceRoot, initial, 'orphan', 'after-evidence');
      assert.equal(result.signal, 'SIGKILL');
      assert.equal(authorityHead(database), initial);
      verifyHistory(database);

      const ref = evidenceRef(payload('orphan'));
      const evidence = new FileEvidenceStore(evidenceRoot);
      assert.deepEqual(evidence.get(ref), payload('orphan'));
      assert.deepEqual(referenceFacts(database), []);
      assert.equal(sweepUnreferenced(evidenceRoot, new Set()), 1);
      assert.throws(() => evidence.get(ref), /EVIDENCE_NOT_FOUND/);
    }

    {
      const database = join(root, 'after-authority.sqlite');
      const evidenceRoot = join(root, 'after-authority-evidence');
      const initial = initialize(database);
      const result = worker(database, evidenceRoot, initial, 'durable', 'after-authority');
      assert.equal(result.signal, 'SIGKILL');
      const head = authorityHead(database);
      assert.ok(head);
      assert.notEqual(head, initial);
      verifyHistory(database);

      const facts = referenceFacts(database);
      assert.equal(facts.length, 1);
      const evidence = new FileEvidenceStore(evidenceRoot);
      assert.deepEqual(evidence.get(facts[0]!.ref), payload('durable'));

      unlinkSync(evidence.pathFor(facts[0]!.ref));
      assert.throws(() => evidence.get(facts[0]!.ref), /EVIDENCE_NOT_FOUND/);
      verifyHistory(database);
    }

    {
      const database = join(root, 'concurrent.sqlite');
      const evidenceRoot = join(root, 'concurrent-evidence');
      const initial = initialize(database);
      const results = await Promise.all([
        concurrentWorker(database, evidenceRoot, initial, 'alpha'),
        concurrentWorker(database, evidenceRoot, initial, 'beta'),
      ]);
      for (const result of results) assert.equal(result.code, 0, result.stderr);
      const outcomes = results.map(
        (result) =>
          JSON.parse(result.stdout) as {
            commit: string | null;
            ref: EvidenceRef;
          },
      );
      assert.equal(outcomes.filter((outcome) => outcome.commit !== null).length, 1);
      verifyHistory(database);

      const facts = referenceFacts(database);
      assert.equal(facts.length, 1);
      const live = new Set(facts.map((fact) => fact.ref.digest));
      const evidence = new FileEvidenceStore(evidenceRoot);
      const winner = facts[0]!;
      assert.deepEqual(evidence.get(winner.ref), payload(winner.label));
      assert.equal(sweepUnreferenced(evidenceRoot, live), 1);
      assert.deepEqual(evidence.get(winner.ref), payload(winner.label));
    }

    console.log(
      'EVIDENCE_REFERENCE_PUBLICATION_RESULT ' +
        JSON.stringify({
          schema: 'overcenter-evidence-reference-publication-result',
          crash_before_authority: 'orphan-only',
          crash_after_authority: 'durable-reference-to-durable-evidence',
          concurrent_authority_winners: 1,
          losing_evidence_collectible: true,
          missing_referenced_evidence: 'fail-closed',
          invalid_histories: 0,
        }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
