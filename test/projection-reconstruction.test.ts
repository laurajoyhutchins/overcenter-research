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
  type WorkProjection,
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

  function revision() {
    return git(authority, ['rev-parse', FACT_REF]);
  }

  function append(fact: ProjectFact) {
    const expected = revision();
    assert.equal(
      git(authority, ['rev-parse', 'HEAD']),
      expected,
      'writer must start from current fact authority',
    );
    if (fact.type === 'run-claimed' && fact.based_on_revision !== expected) {
      throw new Error('STALE_CLAIM_REVISION');
    }

    const path = join(authority, 'facts.ndjson');
    writeFileSync(
      path,
      `${readFileSync(path, 'utf8')}${JSON.stringify(fact)}\n`,
    );
    git(authority, ['add', 'facts.ndjson']);
    git(authority, ['commit', '-m', `fact: ${fact.type}`]);

    const next = git(authority, ['rev-parse', 'HEAD']);
    execFileSync(
      'git',
      ['-C', authority, 'update-ref', FACT_REF, next, expected],
      { stdio: 'ignore' },
    );
    return next;
  }

  function loadFacts(): ProjectFact[] {
    return git(authority, ['show', `${FACT_REF}:facts.ndjson`])
      .split(/\n+/)
      .filter(Boolean)
      .map(line => JSON.parse(line) as ProjectFact);
  }

  function project() {
    return deriveProjectProjection(loadFacts(), revision());
  }

  function materialize() {
    mkdirSync(cache, { recursive: true });
    const projection = canonicalProjection(project());
    writeFileSync(join(cache, 'project-projection.json'), projection);
    return projection;
  }

  function assertReconstructs(expectedWork: WorkProjection[]) {
    const before = materialize();
    assert.deepEqual(JSON.parse(before).work, expectedWork);

    const durableFacts = git(authority, [
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

    const digest = sha256(before);
    rmSync(cache, { recursive: true, force: true });
    assert.equal(existsSync(cache), false);

    const reconstructed = canonicalProjection(project());
    assert.equal(reconstructed, before);
    assert.equal(sha256(reconstructed), digest);
    assert.deepEqual(JSON.parse(reconstructed).work, expectedWork);
  }

  return {
    root,
    authority,
    cache,
    world,
    append,
    revision,
    assertReconstructs,
  };
}

test('every lifecycle projection reconstructs exactly after materialization is deleted', () => {
  const f = fixture();

  try {
    const expectedContent = 'effect-is-present';
    const runId = 'run-1';
    const observationId = 'observation-1';

    f.append({
      type: 'obligation-defined',
      obligation_id: 'publish',
      deps: [],
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: f.world,
        content_sha256: sha256(expectedContent),
      },
    });
    f.append({
      type: 'obligation-defined',
      obligation_id: 'verify-publish',
      deps: ['publish'],
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: `${f.world}.verified`,
        content_sha256: sha256('verified'),
      },
    });
    f.assertReconstructs([
      { id: 'publish', status: 'READY' },
      {
        id: 'verify-publish',
        status: 'BLOCKED',
        blocked_reason: 'DEPENDENCIES_NOT_DONE:publish',
      },
    ]);

    const claimedRevision = f.revision();
    f.append({
      type: 'run-claimed',
      obligation_id: 'publish',
      run_id: runId,
      based_on_revision: claimedRevision,
    });
    f.assertReconstructs([
      { id: 'publish', status: 'EXECUTING', active_run_id: runId },
      {
        id: 'verify-publish',
        status: 'BLOCKED',
        blocked_reason: 'DEPENDENCIES_NOT_DONE:publish',
      },
    ]);

    // External reality may change without changing project truth. Until
    // authoritative observation is recorded and settled, the run is still active.
    writeFileSync(f.world, expectedContent);
    f.assertReconstructs([
      { id: 'publish', status: 'EXECUTING', active_run_id: runId },
      {
        id: 'verify-publish',
        status: 'BLOCKED',
        blocked_reason: 'DEPENDENCIES_NOT_DONE:publish',
      },
    ]);

    f.append({
      type: 'worker-terminated',
      run_id: runId,
      reason: 'sandbox-disappeared',
    });
    f.assertReconstructs([
      {
        id: 'publish',
        status: 'RECOVERY_REQUIRED',
        active_run_id: runId,
      },
      {
        id: 'verify-publish',
        status: 'BLOCKED',
        blocked_reason: 'DEPENDENCIES_NOT_DONE:publish',
      },
    ]);

    const authoritativeReadback = readFileSync(f.world, 'utf8');
    f.append({
      type: 'effect-observed',
      run_id: runId,
      observation_id: observationId,
      verifier: 'file-content-equals/v1',
      mutation_certainty: 'present',
      actual_sha256: sha256(authoritativeReadback),
    });

    // Observation alone is evidence, not settlement.
    f.assertReconstructs([
      {
        id: 'publish',
        status: 'RECOVERY_REQUIRED',
        active_run_id: runId,
      },
      {
        id: 'verify-publish',
        status: 'BLOCKED',
        blocked_reason: 'DEPENDENCIES_NOT_DONE:publish',
      },
    ]);

    f.append({
      type: 'run-settled',
      run_id: runId,
      observation_id: observationId,
    });
    f.assertReconstructs([
      { id: 'publish', status: 'DONE' },
      { id: 'verify-publish', status: 'READY' },
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('claim append is exact-revision fenced', () => {
  const f = fixture();

  try {
    f.append({
      type: 'obligation-defined',
      obligation_id: 'x',
      deps: [],
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: f.world,
        content_sha256: sha256('x'),
      },
    });

    assert.throws(
      () =>
        f.append({
          type: 'run-claimed',
          obligation_id: 'x',
          run_id: 'stale',
          based_on_revision: '0'.repeat(40),
        }),
      /STALE_CLAIM_REVISION/,
    );
    f.assertReconstructs([{ id: 'x', status: 'READY' }]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('settlement disposition is derived from factual observation evidence', () => {
  const expected = sha256('expected');
  const definition: ProjectFact = {
    type: 'obligation-defined',
    obligation_id: 'x',
    deps: [],
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/provider/x',
      content_sha256: expected,
    },
  };

  const replayable: ProjectFact[] = [
    definition,
    {
      type: 'run-claimed',
      obligation_id: 'x',
      run_id: 'r1',
      based_on_revision: 'rev-1',
    },
    {
      type: 'effect-observed',
      run_id: 'r1',
      observation_id: 'o1',
      verifier: 'file-content-equals/v1',
      mutation_certainty: 'absent',
    },
    { type: 'run-settled', run_id: 'r1', observation_id: 'o1' },
  ];
  assert.deepEqual(
    deriveProjectProjection(replayable, 'authority-1').work,
    [{ id: 'x', status: 'READY' }],
  );

  const uncertain: ProjectFact[] = [
    ...replayable,
    {
      type: 'run-claimed',
      obligation_id: 'x',
      run_id: 'r2',
      based_on_revision: 'rev-2',
    },
    {
      type: 'effect-observed',
      run_id: 'r2',
      observation_id: 'o2',
      verifier: 'file-content-equals/v1',
      mutation_certainty: 'uncertain',
    },
    { type: 'run-settled', run_id: 'r2', observation_id: 'o2' },
  ];
  assert.deepEqual(
    deriveProjectProjection(uncertain, 'authority-2').work,
    [{ id: 'x', status: 'RECOVERY_REQUIRED', active_run_id: 'r2' }],
  );
});

test('replay rejects histories that violate authority invariants', () => {
  const definition: ProjectFact = {
    type: 'obligation-defined',
    obligation_id: 'x',
    deps: [],
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/provider/x',
      content_sha256: sha256('expected'),
    },
  };

  assert.throws(
    () =>
      deriveProjectProjection(
        [
          definition,
          {
            type: 'run-claimed',
            obligation_id: 'x',
            run_id: 'r1',
            based_on_revision: 'rev-1',
          },
          {
            type: 'run-claimed',
            obligation_id: 'x',
            run_id: 'r2',
            based_on_revision: 'rev-2',
          },
        ],
        'authority',
      ),
    /CLAIM_WHILE_ACTIVE/,
  );

  assert.throws(
    () =>
      deriveProjectProjection(
        [
          definition,
          {
            type: 'run-claimed',
            obligation_id: 'x',
            run_id: 'r1',
            based_on_revision: 'rev-1',
          },
          {
            type: 'effect-observed',
            run_id: 'r1',
            observation_id: 'o1',
            verifier: 'file-content-equals/v1',
            mutation_certainty: 'present',
            actual_sha256: sha256('expected'),
          },
          { type: 'run-settled', run_id: 'r1', observation_id: 'o1' },
          {
            type: 'run-claimed',
            obligation_id: 'x',
            run_id: 'r2',
            based_on_revision: 'rev-2',
          },
        ],
        'authority',
      ),
    /CLAIM_AFTER_VERIFIED/,
  );
});
