import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OvercenterKernel } from '../../src/authority/kernel.ts';
import type { Postcondition } from '../../src/model.ts';
import {
  GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
  performGithubPullRequestUpdateBranchEffect,
  type GithubUpdateBranchPut,
} from '../../src/providers/github/pr-update-branch-effect.ts';
import type { GithubJsonGet } from '../../src/providers/github/rest.ts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const NEXT = 'c'.repeat(40);
const CLOCK = '2026-09-23T22:15:00.000Z';

type Dispatch = 'not-started' | 'completed';
type RemoteEffect = 'absent' | 'present';
type Response = 'throw' | '502' | '202';
type Visibility = 'old' | 'updated';

interface World {
  id: string;
  dispatch: Dispatch;
  remote_effect: RemoteEffect;
  response: Response;
  visibility: Visibility;
}

interface Result {
  world: World;
  retry_safe_by_physics: boolean;
  adapter_outcome: string;
  durable_fingerprint: string;
  final_status: string;
  reconciliation: string;
  duplicate_put_blocked: boolean;
  observed_certainty: string | null;
}

function repository() {
  return {
    id: 42,
    node_id: 'R_42',
    full_name: 'acme/widget',
    name: 'widget',
    owner: { login: 'acme' },
  };
}

function pull(head = HEAD) {
  return {
    id: 3700,
    node_id: 'PR_node_37',
    number: 37,
    state: 'open',
    head: { sha: head },
    base: { ref: 'main', sha: BASE },
  };
}

function compare(ancestor: string, descendant: string) {
  return {
    status: 'ahead',
    ahead_by: 1,
    behind_by: 0,
    base_commit: { sha: ancestor },
    merge_base_commit: { sha: ancestor },
    commits: [{ sha: descendant }],
  };
}

function postcondition(): Extract<
  Postcondition,
  { verifier: 'github-pull-request-branch-updated/v1' }
> {
  return {
    verifier: 'github-pull-request-branch-updated/v1',
    provider: 'github',
    repository_id: 42,
    repository_full_name: 'acme/widget',
    pull_number: 37,
    pull_node_id: 'PR_node_37',
    expected_previous_head_sha: HEAD,
    base_ref: 'main',
    expected_base_sha: BASE,
  };
}

function define(kernel: OvercenterKernel) {
  kernel.initialize();
  kernel.define({
    id: 'refresh-pr',
    packet: { effect_contract: GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT },
    postcondition: postcondition(),
  });
  const work = kernel.deriveReadyWork();
  assert.ok(work);
  return kernel.claim(work.id, work.revision);
}

function worlds(): World[] {
  const out: World[] = [
    {
      id: 'put-fails-before-dispatch',
      dispatch: 'not-started',
      remote_effect: 'absent',
      response: 'throw',
      visibility: 'old',
    },
  ];

  for (const remote_effect of ['absent', 'present'] as const) {
    for (const response of ['throw', '502', '202'] as const) {
      const visibilities: Visibility[] = remote_effect === 'present' ? ['old', 'updated'] : ['old'];
      for (const visibility of visibilities) {
        out.push({
          id: `dispatch-${remote_effect}-${response}-${visibility}`,
          dispatch: 'completed',
          remote_effect,
          response,
          visibility,
        });
      }
    }
  }
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runWorld(world: World): Promise<Result> {
  const root = mkdtempSync(join(tmpdir(), 'pr-update-branch-uncertainty-'));
  const database = join(root, 'overcenter.sqlite');
  const first = new OvercenterKernel(database);
  let providerState: 'old' | 'updated' = 'old';
  let putCalls = 0;

  try {
    const run = define(first);
    const put: GithubUpdateBranchPut = async () => {
      putCalls += 1;
      assert.equal(first.hasUnresolvedEffect(run.id), true);

      if (world.dispatch === 'not-started') {
        throw new Error('PUT_FAILED_BEFORE_DISPATCH');
      }
      if (world.remote_effect === 'present') providerState = 'updated';
      if (world.response === 'throw') throw new Error('PUT_RESPONSE_LOST_AFTER_DISPATCH');
      if (world.response === '502') return { status: 502, body: 'bad gateway' };
      return { status: 202, body: JSON.stringify({ message: 'Updating pull request branch.' }) };
    };

    let adapterOutcome = 'returned';
    try {
      await performGithubPullRequestUpdateBranchEffect(first, run, {
        token: 'token',
        get: async (_token, path) => {
          if (path === '/repos/acme/widget') return repository();
          if (path === '/repos/acme/widget/pulls/37') return pull();
          throw new Error(`unexpected initial provider path: ${path}`);
        },
        put,
        clock: () => CLOCK,
      });
    } catch (error: unknown) {
      adapterOutcome = `threw:${message(error)}`;
    }

    const unresolvedBeforeRecovery = first.hasUnresolvedEffect(run.id);
    assert.equal(unresolvedBeforeRecovery, true);
    first.close();

    const visibleUpdated = world.visibility === 'updated' && providerState === 'updated';
    const get: GithubJsonGet = (_token, path) => {
      if (path === '/repos/acme/widget') return repository();
      if (path === '/repos/acme/widget/pulls/37') {
        return pull(visibleUpdated ? NEXT : HEAD);
      }
      if (path === `/repos/acme/widget/compare/${HEAD}...${NEXT}`) {
        assert.equal(visibleUpdated, true);
        return compare(HEAD, NEXT);
      }
      if (path === `/repos/acme/widget/compare/${BASE}...${NEXT}`) {
        assert.equal(visibleUpdated, true);
        return compare(BASE, NEXT);
      }
      throw new Error(`unexpected recovery provider path: ${path}`);
    };

    const fresh = new OvercenterKernel(database, {
      githubToken: 'token',
      observationContext: { githubGet: get, clock: () => CLOCK },
    });
    try {
      const recovery = fresh.acquireExecution(run.id);

      const putsBeforeRetry = putCalls;
      let duplicateRetryError = '';
      try {
        await performGithubPullRequestUpdateBranchEffect(fresh, recovery, {
          token: 'token',
          get: async (token, path) => get(token, path),
          put: async () => {
            putCalls += 1;
            return { status: 202, body: '{}' };
          },
          clock: () => CLOCK,
        });
      } catch (error: unknown) {
        duplicateRetryError = message(error);
      }
      const duplicatePutBlocked = putCalls === putsBeforeRetry;
      assert.equal(
        duplicatePutBlocked,
        true,
        `duplicate provider PUT escaped in ${world.id}: ${duplicateRetryError}`,
      );

      const interrupted = fresh.recoverInterrupted(recovery, {
        source: 'github-pr-update-branch-uncertainty',
      });
      const settled = fresh.reconcile(recovery);
      const lifecycle = fresh.inspect()[0];
      assert.ok(lifecycle);

      const receiptSummary = fresh.receipts(run.id).map((receipt) => ({
        kind: receipt.kind,
        disposition: receipt.disposition,
        verified: receipt.verified,
        certainty: receipt.observed?.mutation_certainty ?? null,
        observation_error: receipt.observed?.observation_error ?? null,
      }));
      const durableFingerprint = JSON.stringify({
        unresolved_before_recovery: unresolvedBeforeRecovery,
        duplicate_put_blocked: duplicatePutBlocked,
        interrupted: interrupted.disposition,
        reconciliation: settled.disposition,
        final_status: lifecycle.status,
        receipts: receiptSummary,
      });
      const observedCertainty =
        [...fresh.receipts(run.id)]
          .reverse()
          .find((receipt) => receipt.observed)?.observed?.mutation_certainty ?? null;

      return {
        world,
        retry_safe_by_physics: world.dispatch === 'not-started',
        adapter_outcome: adapterOutcome,
        durable_fingerprint: durableFingerprint,
        final_status: lifecycle.status,
        reconciliation: settled.disposition,
        duplicate_put_blocked: duplicatePutBlocked,
        observed_certainty: observedCertainty,
      };
    } finally {
      fresh.close();
    }
  } finally {
    try {
      first.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

const results: Result[] = [];
for (const world of worlds()) results.push(await runWorld(world));

assert.equal(results.length, 10);
for (const result of results) {
  assert.equal(result.duplicate_put_blocked, true);
  if (result.final_status === 'DONE') {
    assert.equal(result.world.remote_effect, 'present');
    assert.equal(result.world.visibility, 'updated');
  }
  if (result.world.response === '202' && result.world.visibility === 'old') {
    assert.notEqual(result.final_status, 'DONE');
  }
}

const classes = new Map<string, Result[]>();
for (const result of results) {
  const group = classes.get(result.durable_fingerprint) ?? [];
  group.push(result);
  classes.set(result.durable_fingerprint, group);
}

const retrySafetyCollisions = [...classes.values()].filter(
  (group) => new Set(group.map((result) => result.retry_safe_by_physics)).size > 1,
);
assert.ok(
  retrySafetyCollisions.length > 0,
  'expected a durable equivalence class to collapse different physical retry safety',
);

const preDispatch = results.find((result) => result.world.id === 'put-fails-before-dispatch');
const dispatchedHidden = results.find(
  (result) => result.world.id === 'dispatch-present-throw-old',
);
assert.ok(preDispatch);
assert.ok(dispatchedHidden);
assert.equal(preDispatch.retry_safe_by_physics, true);
assert.equal(dispatchedHidden.retry_safe_by_physics, false);
assert.equal(preDispatch.observed_certainty, 'absent');
assert.equal(dispatchedHidden.observed_certainty, 'absent');
assert.equal(
  preDispatch.durable_fingerprint,
  dispatchedHidden.durable_fingerprint,
  'expected preregistered undispatched versus dispatched-hidden collision',
);

const retryOnAnyThrowKilled = results.some(
  (result) =>
    result.adapter_outcome.startsWith('threw:') &&
    result.world.dispatch === 'completed' &&
    result.world.remote_effect === 'present',
);
const retryOnOldHeadAbsenceKilled = results.some(
  (result) =>
    result.world.dispatch === 'completed' &&
    result.world.remote_effect === 'present' &&
    result.world.visibility === 'old' &&
    result.observed_certainty === 'absent' &&
    result.reconciliation === 'RECOVERY_REQUIRED',
);
const trust202Killed = results.some(
  (result) =>
    result.world.response === '202' &&
    result.world.visibility === 'old' &&
    result.final_status !== 'DONE',
);
assert.equal(retryOnAnyThrowKilled, true);
assert.equal(retryOnOldHeadAbsenceKilled, true);
assert.equal(trust202Killed, true);

console.log(
  JSON.stringify(
    {
      experiment: 'github-pr-update-branch-uncertainty',
      worlds: results.length,
      durable_equivalence_classes: classes.size,
      retry_safety_collisions: retrySafetyCollisions.length,
      preregistered_witness: {
        retry_safe: preDispatch.world.id,
        retry_unsafe: dispatchedHidden.world.id,
        shared_durable_state: JSON.parse(preDispatch.durable_fingerprint),
      },
      safety: {
        duplicate_provider_put_observed: false,
        false_done_observed: false,
      },
      negative_controls: {
        retry_on_any_throw: 'KILLED',
        retry_on_old_head_absence: 'KILLED',
        trust_202_without_readback: 'KILLED',
      },
    },
    null,
    2,
  ),
);
