import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  canonicalProjection,
  deriveProjectProjection,
  type ProjectFact,
} from '../src/fact-projection.ts';

const FACT_REF = 'refs/overcenter/facts';
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function git(repo: string, args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-projection-rebuild-'));
  const authority = join(root, 'authority');
  const cache = join(root, 'materialized');
  const world = join(root, 'provider-state.txt');

  execFileSync('git', ['init', authority], { stdio: 'ignore' });
  git(authority, ['config', 'user.email', 'overcenter@example.invalid']);
  git(authority, ['config', 'user.name', 'Overcenter projection proof']);
  writeFileSync(join(authority, 'facts.ndjson'), '');
  git(authority, ['add', 'facts.ndjson']);
  git(authority, ['commit', '-m', 'facts: initialize']);
  git(authority, ['update-ref', FACT_REF, 'HEAD']);

  function append(fact: ProjectFact) {
    const path = join(authority, 'facts.ndjson');
    const existing = readFileSync(path, 'utf8');
    writeFileSync(path, `${existing}${JSON.stringify(fact)}\n`);
    git(authority, ['add', 'facts.ndjson']);
    git(authority, ['commit', '-m', `fact: ${fact.type}`]);
    git(authority, ['update-ref', FACT_REF, 'HEAD']);
    return git(authority, ['rev-parse', FACT_REF]);
  }

  function loadFacts(): ProjectFact[] {
    const raw = git(authority, ['show', `${FACT_REF}:facts.ndjson`]);
    return raw
      .split(/\n+/)
      .filter(Boolean)
      .map(line => JSON.parse(line) as ProjectFact);
  }

  function project() {
    const revision = git(authority, ['rev-parse', FACT_REF]);
    return deriveProjectProjection(loadFacts(), revision);
  }

  function materialize() {
    mkdirSync(cache, { recursive: true });
    const projection = canonicalProjection(project());
    writeFileSync(join(cache, 'project-projection.json'), projection);
    return projection;
  }

  return {
    root,
    authority,
    cache,
    world,
    append,
    project,
    materialize,
  };
}

test('project projection reconstructs exactly after every materialized status/cache is deleted', () => {
  const f = fixture();

  try {
    const expectedContent = 'effect-is-present';
    const runId = 'run-1';
    const observationId = 'observation-1';

    let revision = f.append({
      type: 'obligation-defined',
      obligation_id: 'publish',
      deps: [],
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: f.world,
        content_sha256: sha256(expectedContent),
      },
    });

    assert.deepEqual(f.project().work, [
      { id: 'publish', status: 'READY' },
    ]);

    revision = f.append({
      type: 'run-claimed',
      obligation_id: 'publish',
      run_id: runId,
      based_on_revision: revision,
    });

    assert.deepEqual(f.project().work, [
      { id: 'publish', status: 'EXECUTING', active_run_id: runId },
    ]);

    writeFileSync(f.world, expectedContent);

    f.append({
      type: 'worker-terminated',
      run_id: runId,
      reason: 'sandbox-disappeared',
    });

    assert.deepEqual(f.project().work, [
      {
        id: 'publish',
        status: 'RECOVERY_REQUIRED',
        active_run_id: runId,
      },
    ]);

    const authoritativeReadback = readFileSync(f.world, 'utf8');

    f.append({
      type: 'effect-observed',
      run_id: runId,
      observation_id: observationId,
      verifier: 'file-content-equals/v1',
      mutation_certainty: 'present',
      predicate_holds:
        sha256(authoritativeReadback) === sha256(expectedContent),
      actual_sha256: sha256(authoritativeReadback),
    });

    f.append({
      type: 'run-settled',
      run_id: runId,
      observation_id: observationId,
      result: 'verified',
    });

    const before = f.materialize();
    const beforeDigest = sha256(before);

    assert.deepEqual(JSON.parse(before).work, [
      { id: 'publish', status: 'DONE' },
    ]);
    assert.equal(
      existsSync(join(f.cache, 'project-projection.json')),
      true,
    );

    const durableFacts = git(f.authority, [
      'show',
      `${FACT_REF}:facts.ndjson`,
    ]);

    assert.equal(
      /"status"\s*:/.test(durableFacts),
      false,
      'durable journal must not persist projected status',
    );
    for (const label of [
      'READY',
      'EXECUTING',
      'BLOCKED',
      'RECOVERY_REQUIRED',
      'DONE',
    ]) {
      assert.equal(
        durableFacts.includes(label),
        false,
        `projection label leaked into durable facts: ${label}`,
      );
    }

    rmSync(f.cache, { recursive: true, force: true });
    assert.equal(existsSync(f.cache), false);

    // Fresh reconstruction: load only durable facts reachable from the
    // current authority ref. No status/cache survives this boundary.
    const reconstructed = canonicalProjection(f.project());
    const reconstructedDigest = sha256(reconstructed);

    assert.equal(reconstructed, before);
    assert.equal(reconstructedDigest, beforeDigest);
    assert.deepEqual(JSON.parse(reconstructed).work, [
      { id: 'publish', status: 'DONE' },
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
