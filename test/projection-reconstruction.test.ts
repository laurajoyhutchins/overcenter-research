import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../src/git-kernel.ts';

const STATE_REF = 'refs/overcenter/state';
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function git(repo: string, args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-kernel-rebuild-'));
  const authority = join(root, 'authority.git');
  const cache = join(root, 'materialized');
  const world = join(root, 'provider-state.txt');
  let cloneNumber = 0;

  execFileSync('git', ['init', '--bare', authority], { stdio: 'ignore' });
  const owner = new GitOvercenterKernel(authority);
  owner.initialize();

  function canonicalProjection(kernel: GitOvercenterKernel) {
    return `${JSON.stringify(kernel.inspect(), null, 2)}\n`;
  }

  function freshKernel() {
    cloneNumber += 1;
    const repo = join(root, `reconstructor-${cloneNumber}.git`);
    execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
    git(repo, ['remote', 'add', 'origin', authority]);
    git(repo, ['fetch', '--no-tags', 'origin', `+${STATE_REF}:${STATE_REF}`]);
    return { repo, kernel: new GitOvercenterKernel(repo, { remote: 'origin' }) };
  }

  function assertFactOnlyAuthority() {
    const commits = git(authority, ['rev-list', STATE_REF])
      .split(/\n+/)
      .filter(Boolean);

    for (const commit of commits) {
      assert.throws(
        () => git(authority, ['cat-file', '-e', `${commit}:state.json`]),
      );
    }
  }

  function assertReconstructs(expected: Array<[string, string]>) {
    const before = canonicalProjection(owner);
    assert.deepEqual(
      JSON.parse(before).map((work: { id: string; status: string }) => [
        work.id,
        work.status,
      ]),
      expected,
    );

    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'project-projection.json'), before);
    const digest = sha256(before);
    assertFactOnlyAuthority();

    rmSync(cache, { recursive: true, force: true });
    assert.equal(existsSync(cache), false);

    const fresh = freshKernel();
    try {
      const reconstructed = canonicalProjection(fresh.kernel);
      assert.equal(reconstructed, before);
      assert.equal(sha256(reconstructed), digest);
    } finally {
      rmSync(fresh.repo, { recursive: true, force: true });
    }
  }

  return {
    root,
    authority,
    world,
    owner,
    assertReconstructs,
  };
}

test('GitOvercenterKernel reconstructs the same projection after every materialization is deleted', () => {
  const f = fixture();

  try {
    f.owner.define({
      id: 'publish',
      packet: { path: f.world, content: 'present' },
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: f.world,
        content: 'present',
      },
    });
    f.owner.define({
      id: 'verify-publish',
      dependencies: [{ kind: 'control', upstream: 'publish' }],
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: `${f.world}.verified`,
        content: 'verified',
      },
    });

    f.assertReconstructs([
      ['publish', 'READY'],
      ['verify-publish', 'BLOCKED'],
    ]);

    const run = f.owner.claim(
      'publish',
      f.owner.deriveReadyWork()!.revision,
    );

    const claimFact = JSON.parse(
      git(f.authority, ['show', `${run.claim_commit}:claim.json`]),
    ) as {
      run_id: string;
      obligation_id: string;
      claimed_revision: string;
    };
    assert.equal(claimFact.run_id, run.id);
    assert.equal(claimFact.obligation_id, 'publish');
    assert.equal(claimFact.claimed_revision, run.claimed_revision);

    f.assertReconstructs([
      ['publish', 'EXECUTING'],
      ['verify-publish', 'BLOCKED'],
    ]);

    // External truth changes, then the original execution disappears. The
    // later lifecycle and settlement are reconstructed from durable facts.
    writeFileSync(f.world, 'present');
    f.assertReconstructs([
      ['publish', 'EXECUTING'],
      ['verify-publish', 'BLOCKED'],
    ]);

    const recovery = f.owner.recoverInterrupted(run, {
      source: 'projection-erasure-proof',
    });
    assert.equal(recovery.disposition, 'RECOVERY_REQUIRED');
    assert.equal(recovery.claim_commit, run.claim_commit);

    f.assertReconstructs([
      ['publish', 'RECOVERY_REQUIRED'],
      ['verify-publish', 'BLOCKED'],
    ]);

    const settled = f.owner.reconcile(run);
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.claim_commit, run.claim_commit);

    f.assertReconstructs([
      ['publish', 'DONE'],
      ['verify-publish', 'READY'],
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
