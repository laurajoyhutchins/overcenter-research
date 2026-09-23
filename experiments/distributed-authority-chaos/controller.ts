import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitOvercenterKernel } from '../../src/storage/git-kernel.ts';
import type { ExecutionPermit, Work } from '../../src/model.ts';

const CONTROLLERS = 8;
const DEFAULT_TASKS = 48;
const LOCAL_TASKS = 6;
const FIXTURE = '/tmp/overcenter-distributed-authority-chaos-fixture';
const FIXTURE_CONTENT = 'stable-authority-observation';
const MAX_RETRIES = 96;

type Remote = string;
type CrashStage = 'after-claim' | 'after-reservation' | 'after-rotation' | null;

function taskId(index: number): string {
  return `chaos-${String(index).padStart(4, '0')}`;
}

function taskIndex(id: string): number {
  const match = /^chaos-(\d{4})$/.exec(id);
  if (!match) throw new Error(`INVALID_CHAOS_TASK_ID:${id}`);
  return Number(match[1]);
}

function mode(index: number): number {
  return index % 6;
}

function requiresReservation(index: number): boolean {
  return [1, 3, 5].includes(mode(index));
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readJson(repo: string, commit: string, path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(git(repo, ['show', `${commit}:${path}`])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function kernel(repo: string, ref: string, remote: Remote): GitOvercenterKernel {
  return new GitOvercenterKernel(repo, { ref, remote });
}

function ensureFixture(): void {
  writeFileSync(FIXTURE, FIXTURE_CONTENT);
}

function transient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /STALE_REVISION|CLAIM_LOST|STALE_EXECUTION_GENERATION|AUTHORITY_LOST|RUN_ALREADY_TERMINAL|RUN_NOT_EXECUTING|NOT_RESOLVABLE|EXECUTION_AUTHORITY_CONTENTION_EXHAUSTED|EFFECT_RESERVATION_CONTENTION_EXHAUSTED|RECOVERY_CONTENTION_EXHAUSTED|RESOLVE_CONTENTION_EXHAUSTED/.test(
    message,
  );
}

function obligations(tasks: number) {
  return Array.from({ length: tasks }, (_, index) => ({
    id: taskId(index),
    packet: {
      chaos_index: index,
      chaos_mode: mode(index),
      controller_owner: index % CONTROLLERS,
    },
    postcondition: {
      verifier: 'file-content-equals/v1' as const,
      path: FIXTURE,
      content: FIXTURE_CONTENT,
    },
  }));
}

function setup(repo: string, ref: string, remote: Remote, tasks: number): void {
  ensureFixture();
  const authority = kernel(repo, ref, remote);
  const initialized = authority.initialize();
  const revision = authority.applyGraphPatch({ upsert: obligations(tasks) }, initialized);
  assert.equal(authority.inspect().length, tasks);
  assert.ok(authority.inspect().every((work) => work.status === 'READY'));
  console.log(JSON.stringify({ kind: 'chaos-setup', tasks, revision }));
}

function reserve(authority: GitOvercenterKernel, permit: ExecutionPermit): void {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      authority.beginEffect(permit);
      return;
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'EFFECT_RESERVATION_CONTENTION_EXHAUSTED') {
        continue;
      }
      throw error;
    }
  }
  throw new Error('CHAOS_RESERVATION_RETRY_EXHAUSTED');
}

function resolveDone(
  authority: GitOvercenterKernel,
  permit: ExecutionPermit,
  diagnostic: Record<string, unknown>,
): void {
  const receipt = authority.resolve(permit, diagnostic);
  assert.equal(receipt.disposition, 'DONE');
  assert.equal(receipt.verified, true);
}

function recoverActive(
  authority: GitOvercenterKernel,
  work: Work,
  injectCrashes: boolean,
): { crashed: CrashStage; generation?: number } {
  assert.ok(work.run_id);
  const index = taskIndex(work.id);
  const permit = authority.acquireExecution(work.run_id);

  if (injectCrashes && [4, 5].includes(mode(index)) && permit.execution_generation === 2) {
    console.log(
      JSON.stringify({
        kind: 'chaos-crash',
        task: work.id,
        stage: 'after-rotation',
        generation: permit.execution_generation,
      }),
    );
    return { crashed: 'after-rotation', generation: permit.execution_generation };
  }

  if (authority.hasUnresolvedEffect(permit.id)) {
    assert.throws(() => authority.beginEffect(permit), /UNRESOLVED_EFFECT/);
  }

  if (work.status === 'EXECUTING') {
    const interrupted = authority.recoverInterrupted(permit, {
      source: 'distributed-authority-chaos',
      event: 'controller-terminated',
    });
    assert.equal(interrupted.disposition, 'RECOVERY_REQUIRED');
  }

  resolveDone(authority, permit, {
    source: 'distributed-authority-chaos',
    event: 'fresh-controller-recovery',
  });
  return { crashed: null, generation: permit.execution_generation };
}

function claimReady(
  authority: GitOvercenterKernel,
  work: Work,
  injectCrashes: boolean,
): { crashed: CrashStage; generation?: number } {
  const index = taskIndex(work.id);
  const taskMode = mode(index);
  const permit = authority.claim(work.id, work.revision);

  if (injectCrashes && [2, 4].includes(taskMode)) {
    console.log(
      JSON.stringify({
        kind: 'chaos-crash',
        task: work.id,
        stage: 'after-claim',
        generation: permit.execution_generation,
      }),
    );
    return { crashed: 'after-claim', generation: permit.execution_generation };
  }

  if (requiresReservation(index)) {
    reserve(authority, permit);
    if (injectCrashes && [3, 5].includes(taskMode)) {
      console.log(
        JSON.stringify({
          kind: 'chaos-crash',
          task: work.id,
          stage: 'after-reservation',
          generation: permit.execution_generation,
        }),
      );
      return { crashed: 'after-reservation', generation: permit.execution_generation };
    }
  }

  resolveDone(authority, permit, {
    source: 'distributed-authority-chaos',
    event: 'same-controller-settlement',
  });
  return { crashed: null, generation: permit.execution_generation };
}

function runWave(
  repo: string,
  ref: string,
  remote: Remote,
  controllerId: number,
  tasks: number,
  injectCrashes: boolean,
): { completed: number; crashed: CrashStage; conflicts: number } {
  ensureFixture();
  assert.ok(Number.isInteger(controllerId) && controllerId >= 0 && controllerId < CONTROLLERS);
  const authority = kernel(repo, ref, remote);
  let completed = 0;
  let conflicts = 0;

  for (let index = controllerId; index < tasks; index += CONTROLLERS) {
    const id = taskId(index);
    let finished = false;

    for (let retry = 0; retry < MAX_RETRIES && !finished; retry += 1) {
      const work = authority.inspect().find((candidate) => candidate.id === id);
      assert.ok(work, `missing work ${id}`);
      if (work.status === 'DONE') {
        finished = true;
        break;
      }

      try {
        const result =
          work.status === 'READY'
            ? claimReady(authority, work, injectCrashes)
            : recoverActive(authority, work, injectCrashes);
        if (result.crashed) {
          return { completed, crashed: result.crashed, conflicts };
        }
        completed += 1;
        finished = true;
      } catch (error: unknown) {
        if (!transient(error)) throw error;
        conflicts += 1;
      }
    }

    if (!finished) throw new Error(`CHAOS_TASK_RETRY_EXHAUSTED:${id}`);
  }

  console.log(
    JSON.stringify({
      kind: 'chaos-wave-complete',
      controller: controllerId,
      completed,
      conflicts,
    }),
  );
  return { completed, crashed: null, conflicts };
}

function sweep(
  repo: string,
  ref: string,
  remote: Remote,
  tasks: number,
  maxTransitions: number,
): number {
  ensureFixture();
  const authority = kernel(repo, ref, remote);
  let transitions = 0;

  while (transitions < maxTransitions) {
    const work = authority.inspect();
    if (work.length !== tasks) throw new Error('CHAOS_TASK_COUNT_DRIFT');
    if (work.every((candidate) => candidate.status === 'DONE')) {
      console.log(JSON.stringify({ kind: 'chaos-sweep', transitions, status: 'DONE' }));
      return transitions;
    }

    const active = work
      .filter(
        (candidate) =>
          candidate.run_id &&
          ['EXECUTING', 'RECOVERY_REQUIRED', 'WAITING'].includes(candidate.status),
      )
      .sort((left, right) => left.id.localeCompare(right.id))[0];

    try {
      if (active) {
        recoverActive(authority, active, false);
      } else {
        const ready = work
          .filter((candidate) => candidate.status === 'READY')
          .sort((left, right) => left.id.localeCompare(right.id))[0];
        if (!ready) throw new Error('CHAOS_NO_PROGRESSABLE_WORK');
        claimReady(authority, ready, false);
      }
      transitions += 1;
    } catch (error: unknown) {
      if (!transient(error)) throw error;
    }
  }

  throw new Error(`CHAOS_SWEEP_BOUND_EXCEEDED:${maxTransitions}`);
}

function finalReceipt(authority: GitOvercenterKernel, id: string) {
  const receipt = authority
    .receipts()
    .filter((candidate) => candidate.obligation_id === id)
    .at(-1);
  assert.ok(receipt, `missing receipt for ${id}`);
  return receipt;
}

function verify(repo: string, ref: string, remote: Remote, tasks: number): void {
  ensureFixture();
  const authority = kernel(repo, ref, remote);
  const work = authority.inspect();
  assert.equal(work.length, tasks);
  assert.ok(work.every((candidate) => candidate.status === 'DONE'));

  const head = authority.head();
  assert.ok(head);
  const revisions = git(repo, ['rev-list', '--reverse', head]).split(/\n+/).filter(Boolean);
  const claims = revisions
    .map((commit) => readJson(repo, commit, 'claim.json'))
    .filter((value): value is Record<string, unknown> => value !== null);
  const reservations = revisions
    .map((commit) => readJson(repo, commit, 'effect-reservation.json'))
    .filter((value): value is Record<string, unknown> => value !== null);

  const claimsByObligation = new Map<string, Record<string, unknown>[]>();
  for (const claim of claims) {
    const id = String(claim.obligation_id);
    claimsByObligation.set(id, [...(claimsByObligation.get(id) ?? []), claim]);
  }
  assert.equal(claimsByObligation.size, tasks);
  for (let index = 0; index < tasks; index += 1) {
    assert.equal(claimsByObligation.get(taskId(index))?.length, 1, `claim count ${taskId(index)}`);
  }

  const reservationsByRun = new Map<string, number>();
  for (const reservation of reservations) {
    const runId = String(reservation.run_id);
    reservationsByRun.set(runId, (reservationsByRun.get(runId) ?? 0) + 1);
  }
  assert.ok([...reservationsByRun.values()].every((count) => count === 1));

  for (const index of [3, 5]) {
    const claim = claimsByObligation.get(taskId(index))?.[0];
    assert.ok(claim);
    assert.equal(reservationsByRun.get(String(claim.run_id)), 1);
  }

  assert.ok(finalReceipt(authority, taskId(2)).execution_generation >= 2);
  assert.ok(finalReceipt(authority, taskId(3)).execution_generation >= 2);
  assert.ok(finalReceipt(authority, taskId(4)).execution_generation >= 3);
  assert.ok(finalReceipt(authority, taskId(5)).execution_generation >= 3);

  console.log(
    JSON.stringify({
      kind: 'chaos-verify',
      tasks,
      claims: claims.length,
      reservations: reservations.length,
      task_0002_generation: finalReceipt(authority, taskId(2)).execution_generation,
      task_0003_generation: finalReceipt(authority, taskId(3)).execution_generation,
      task_0004_generation: finalReceipt(authority, taskId(4)).execution_generation,
      task_0005_generation: finalReceipt(authority, taskId(5)).execution_generation,
      status: 'PASS',
    }),
  );
}

function freshRepo(root: string, name: string, remote: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  return repo;
}

function localContract(): void {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-authority-chaos-'));
  const remote = join(root, 'authority.git');
  const ref = 'refs/heads/authority-chaos';

  try {
    execFileSync('git', ['init', '--bare', '-q', remote]);
    setup(freshRepo(root, 'setup', remote), ref, 'origin', LOCAL_TASKS);

    for (let wave = 1; wave <= 3; wave += 1) {
      for (let controllerId = 0; controllerId < CONTROLLERS; controllerId += 1) {
        runWave(
          freshRepo(root, `wave-${wave}-controller-${controllerId}`, remote),
          ref,
          'origin',
          controllerId,
          LOCAL_TASKS,
          true,
        );
      }
    }

    const sweepTransitions = sweep(
      freshRepo(root, 'sweeper', remote),
      ref,
      'origin',
      LOCAL_TASKS,
      256,
    );
    assert.ok(sweepTransitions <= 256);
    verify(freshRepo(root, 'verifier', remote), ref, 'origin', LOCAL_TASKS);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(FIXTURE, { force: true });
  }
}

function hostedRepo(): string {
  return process.cwd();
}

function integer(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`INVALID_${name}`);
  return parsed;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'local') {
  localContract();
} else if (command === 'setup') {
  const [ref, tasksText] = args;
  assert.ok(ref);
  setup(hostedRepo(), ref, 'origin', integer(tasksText, 'TASKS'));
} else if (command === 'wave') {
  const [ref, controllerText, tasksText] = args;
  assert.ok(ref);
  const result = runWave(
    hostedRepo(),
    ref,
    'origin',
    integer(controllerText, 'CONTROLLER'),
    integer(tasksText, 'TASKS'),
    true,
  );
  console.log(JSON.stringify({ kind: 'chaos-wave-result', ...result }));
} else if (command === 'sweep') {
  const [ref, tasksText, maxText] = args;
  assert.ok(ref);
  sweep(
    hostedRepo(),
    ref,
    'origin',
    integer(tasksText, 'TASKS'),
    integer(maxText, 'MAX_TRANSITIONS'),
  );
} else if (command === 'verify') {
  const [ref, tasksText] = args;
  assert.ok(ref);
  verify(hostedRepo(), ref, 'origin', integer(tasksText, 'TASKS'));
} else {
  throw new Error('usage: controller.ts local|setup|wave|sweep|verify');
}
