import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitOvercenterKernel } from '../../src/storage/git-kernel.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  performGithubCommitStatusEffect,
} from '../../src/providers/github/status-effect.ts';

const OBLIGATION_ID = 'distributed-authority-status';

function git(repo: string, args: string[], allowFailure = false): string {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `git ${args.join(' ')} failed: ${String(result.stderr ?? result.stdout).trim()}`,
    );
  }
  return result.status === 0 ? String(result.stdout).trim() : '';
}

function remoteKernel(ref: string, token: string | null = null): GitOvercenterKernel {
  return new GitOvercenterKernel(process.cwd(), {
    ref,
    remote: 'origin',
    githubToken: token,
  });
}

function countFact(ref: string, path: string): number {
  const revisions = git(process.cwd(), ['rev-list', '--reverse', ref]).split(/\n+/).filter(Boolean);
  return revisions.filter((commit) => {
    const result = spawnSync('git', ['-C', process.cwd(), 'cat-file', '-e', `${commit}:${path}`], {
      stdio: 'ignore',
    });
    return result.status === 0;
  }).length;
}

const sleep = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

async function hostedSetup(args: string[]): Promise<void> {
  const [ref, repositoryIdText, repositoryFullName, sourceSha, context] = args;
  assert.ok(ref && repositoryIdText && repositoryFullName && sourceSha && context);
  const repositoryId = Number(repositoryIdText);
  assert.ok(Number.isSafeInteger(repositoryId) && repositoryId > 0);

  const kernel = remoteKernel(ref);
  kernel.initialize();
  const initialRevision = kernel.define({
    id: OBLIGATION_ID,
    packet: { effect_contract: GITHUB_COMMIT_STATUS_EFFECT },
    postcondition: {
      verifier: 'github-commit-status/v2',
      provider: 'github',
      repository_id: repositoryId,
      repository_full_name: repositoryFullName,
      commit_sha: sourceSha,
      context,
      expected_state: 'success',
    },
  });

  const ready = kernel.deriveReadyWork();
  assert.equal(ready?.id, OBLIGATION_ID);
  assert.equal(ready?.revision, initialRevision);
  console.log(JSON.stringify({ authority_ref: ref, initial_revision: initialRevision }));
}

async function hostedRace(args: string[]): Promise<void> {
  const [ref, expectedRevision, contender, sourceSha] = args;
  assert.ok(ref && expectedRevision && contender && sourceSha);
  assert.ok(contender === 'a' || contender === 'b');

  const kernel = remoteKernel(ref);
  const ready = kernel.deriveReadyWork();
  if (!ready || ready.revision !== expectedRevision) {
    console.log(JSON.stringify({ contender, outcome: 'lost', reason: 'stale-before-barrier' }));
    return;
  }

  const marker = `${ref}-ready-${contender}`;
  const other = `${ref}-ready-${contender === 'a' ? 'b' : 'a'}`;
  git(process.cwd(), ['push', '--quiet', 'origin', `${sourceSha}:${marker}`]);

  let observedOther = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (git(process.cwd(), ['ls-remote', '--exit-code', 'origin', other], true)) {
      observedOther = true;
      break;
    }
    await sleep(500);
  }
  assert.equal(observedOther, true, 'both contenders must reach the remote barrier');

  try {
    const permit = kernel.claim(OBLIGATION_ID, expectedRevision);
    console.log(
      JSON.stringify({
        contender,
        outcome: 'won',
        run_id: permit.id,
        claim_commit: permit.claim_commit,
      }),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /^(STALE_REVISION|CLAIM_LOST)$/);
    console.log(JSON.stringify({ contender, outcome: 'lost', reason: message }));
  }
}

async function hostedVerifyRace(args: string[]): Promise<void> {
  const [ref] = args;
  assert.ok(ref);
  const kernel = remoteKernel(ref);
  const work = kernel.inspect();
  assert.equal(work.length, 1);
  assert.equal(work[0]?.id, OBLIGATION_ID);
  assert.equal(work[0]?.status, 'EXECUTING');
  assert.ok(work[0]?.run_id);
  assert.equal(countFact(ref, 'claim.json'), 1);
  console.log(
    JSON.stringify({
      run_id: work[0]!.run_id,
      head: kernel.head(),
      claims: countFact(ref, 'claim.json'),
    }),
  );
}

async function hostedReserve(args: string[]): Promise<void> {
  const [ref] = args;
  const token = process.env.GITHUB_TOKEN ?? '';
  assert.ok(ref && token);

  const kernel = remoteKernel(ref, token);
  const work = kernel.inspect().find((candidate) => candidate.id === OBLIGATION_ID);
  assert.ok(work?.run_id);
  const permit = kernel.acquireExecution(work.run_id);
  const effect = await performGithubCommitStatusEffect(kernel, permit, { token });

  assert.equal(effect.state, 'success');
  assert.equal(kernel.hasUnresolvedEffect(permit.id), true);
  assert.equal(countFact(ref, 'effect-reservation.json'), 1);
  console.log(
    JSON.stringify({
      run_id: permit.id,
      execution_generation: permit.execution_generation,
      reservation_count: 1,
      authority_head: kernel.head(),
      effect,
    }),
  );
}

async function hostedRecover(args: string[]): Promise<void> {
  const [ref] = args;
  const token = process.env.GITHUB_TOKEN ?? '';
  assert.ok(ref && token);

  const kernel = remoteKernel(ref, token);
  const work = kernel.inspect().find((candidate) => candidate.id === OBLIGATION_ID);
  assert.ok(work?.run_id);
  const permit = kernel.acquireExecution(work.run_id);

  assert.throws(() => kernel.beginEffect(permit), /UNRESOLVED_EFFECT/);
  const interrupted = kernel.recoverInterrupted(permit, {
    source: 'distributed-authority-handoff',
    prior_controller: 'terminated-after-provider-effect',
  });
  assert.equal(interrupted.disposition, 'RECOVERY_REQUIRED');

  let settled = await kernel.resolveAsync(permit, {
    source: 'distributed-authority-handoff-fresh-controller',
  });
  for (let attempt = 0; settled.disposition !== 'DONE' && attempt < 8; attempt += 1) {
    await sleep(750);
    settled = await kernel.resolveAsync(permit, {
      source: 'distributed-authority-handoff-fresh-controller',
      observation_retry: attempt + 1,
    });
  }

  assert.equal(settled.disposition, 'DONE');
  assert.equal(settled.verified, true);
  assert.equal(kernel.hasUnresolvedEffect(permit.id), false);
  assert.equal(kernel.inspect()[0]?.status, 'DONE');
  assert.equal(countFact(ref, 'claim.json'), 1);
  assert.equal(countFact(ref, 'effect-reservation.json'), 1);
  console.log(
    JSON.stringify({
      run_id: permit.id,
      execution_generation: permit.execution_generation,
      disposition: settled.disposition,
      claims: 1,
      reservations: 1,
      authority_head: kernel.head(),
    }),
  );
}

async function hostedControls(args: string[]): Promise<void> {
  const [ref, staleRevision] = args;
  assert.ok(ref && staleRevision);

  const kernel = remoteKernel(ref);
  assert.throws(() => kernel.claim(OBLIGATION_ID, staleRevision), /STALE_REVISION/);

  const localHead = kernel.head();
  assert.ok(localHead);
  assert.equal(git(process.cwd(), ['rev-parse', ref]), localHead);

  git(process.cwd(), ['remote', 'set-url', 'origin', 'https://127.0.0.1:9/unreachable']);
  assert.throws(() => kernel.inspect(), /AUTHORITY_UNREACHABLE/);
  assert.equal(git(process.cwd(), ['rev-parse', ref]), localHead);

  console.log(
    JSON.stringify({
      stale_revision_rejected: true,
      local_authority_copy_present: true,
      remote_unavailable_failed_closed: true,
    }),
  );
}

function initLocalController(root: string, name: string, remote: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  return repo;
}

function localContract(): void {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-distributed-authority-'));
  const remote = join(root, 'authority.git');
  const ref = 'refs/heads/authority';
  const shared = join(root, 'provider-state.txt');

  try {
    execFileSync('git', ['init', '--bare', '-q', remote]);
    const controllerA = initLocalController(root, 'controller-a', remote);
    const controllerB = initLocalController(root, 'controller-b', remote);
    const controllerC = initLocalController(root, 'controller-c', remote);
    const controllerD = initLocalController(root, 'controller-d', remote);
    const controllerE = initLocalController(root, 'controller-e', remote);

    const a = new GitOvercenterKernel(controllerA, { ref, remote });
    a.initialize();
    const initialRevision = a.define({
      id: 'local-handoff',
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: shared,
        content: 'present',
      },
    });

    const b = new GitOvercenterKernel(controllerB, { ref, remote });
    assert.equal(a.deriveReadyWork()?.revision, initialRevision);
    assert.equal(b.deriveReadyWork()?.revision, initialRevision);

    const winner = a.claim('local-handoff', initialRevision);
    assert.throws(() => b.claim('local-handoff', initialRevision), /STALE_REVISION|CLAIM_LOST/);

    const c = new GitOvercenterKernel(controllerC, { ref, remote });
    assert.equal(c.inspect()[0]?.run_id, winner.id);
    const broker = c.acquireExecution(winner.id);
    c.beginEffect(broker);
    writeFileSync(shared, 'present');
    assert.equal(c.hasUnresolvedEffect(winner.id), true);

    const d = new GitOvercenterKernel(controllerD, { ref, remote });
    const recovery = d.acquireExecution(winner.id);
    assert.throws(() => d.beginEffect(recovery), /UNRESOLVED_EFFECT/);
    d.recoverInterrupted(recovery, { source: 'local-contract' });
    const settled = d.resolve(recovery, { source: 'fresh-local-controller' });
    assert.equal(settled.disposition, 'DONE');
    assert.equal(d.inspect()[0]?.status, 'DONE');

    assert.throws(() => {
      const stale = new GitOvercenterKernel(controllerE, { ref, remote });
      stale.claim('local-handoff', initialRevision);
    }, /STALE_REVISION/);

    const localCopy = new GitOvercenterKernel(controllerE, { ref, remote: 'origin' });
    const copiedHead = localCopy.head();
    assert.ok(copiedHead);
    execFileSync('git', [
      '-C',
      controllerE,
      'remote',
      'set-url',
      'origin',
      join(root, 'missing.git'),
    ]);
    assert.throws(() => localCopy.inspect(), /AUTHORITY_UNREACHABLE/);
    assert.equal(
      execFileSync('git', ['-C', controllerE, 'rev-parse', ref], { encoding: 'utf8' }).trim(),
      copiedHead,
    );

    console.log(
      JSON.stringify({
        local_contract: 'pass',
        winner_run: winner.id,
        final_status: 'DONE',
        stale_revision_rejected: true,
        remote_unavailable_failed_closed: true,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'local') localContract();
  else if (command === 'setup') await hostedSetup(args);
  else if (command === 'race') await hostedRace(args);
  else if (command === 'verify-race') await hostedVerifyRace(args);
  else if (command === 'reserve') await hostedReserve(args);
  else if (command === 'recover') await hostedRecover(args);
  else if (command === 'controls') await hostedControls(args);
  else
    throw new Error('usage: controller.ts local|setup|race|verify-race|reserve|recover|controls');
}

await main();
