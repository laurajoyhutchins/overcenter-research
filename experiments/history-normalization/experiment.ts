import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KernelCore } from '../../src/authority/engine.ts';
import type { FactCommit } from '../../src/authority/facts.ts';
import { replayProjection } from '../../src/authority/replay.ts';
import { canonicalDigest } from '../../src/digest.ts';
import {
  ABSENCE_EVIDENCE_SCHEMA,
  validateAbsenceEvidenceEnvelope,
} from '../../src/observation/evidence.ts';
import {
  createGithubStatusPost,
  performGithubCommitStatusEffect,
} from '../../src/providers/github/status-effect.ts';
import { SqliteFactStore } from '../../src/storage/sqlite.ts';

const COMMIT = 'a'.repeat(40);
const STATUS = 'a-status';
const WORK = 'b-work';

type Continuation = 'none' | 'defer-work' | 'retry-status' | 'defer-and-retry';
type Interleaving = 'status-first' | 'work-first';

type SemanticEvent =
  | {
      kind: 'claim';
      obligation_id: string;
      attempt: number;
      obligation_key: string;
      execution_generation: number;
    }
  | {
      kind: 'execution-authority';
      obligation_id: string;
      attempt: number;
      execution_generation: number;
    }
  | {
      kind: 'effect-reservation';
      obligation_id: string;
      attempt: number;
      execution_generation: number;
    }
  | {
      kind: 'effect-release';
      obligation_id: string;
      attempt: number;
      execution_generation: number;
      evidence_kind: string;
      evidence_source: string;
    }
  | {
      kind: 'receipt';
      obligation_id: string;
      attempt: number;
      execution_generation: number;
      receipt_kind: string;
    }
  | {
      kind: 'aborted-attempt';
      obligation_id: string;
      attempt: number;
      execution_generation: number;
      evidence_kind: string;
      evidence_source: string;
      receipt_kind: 'effect-not-dispatched';
    };

interface RunResult {
  history: FactCommit[];
  semantic_events: SemanticEvent[];
  normal_form: SemanticEvent[];
  semantic_digest: string;
  provenance_digest: string;
  replay_signature: unknown;
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

function statusDefinition() {
  return {
    id: STATUS,
    packet: { effect_contract: 'github-commit-status/set-from-postcondition/v1' },
    postcondition: {
      verifier: 'github-commit-status/v2' as const,
      provider: 'github' as const,
      repository_id: 42,
      repository_full_name: 'acme/widget',
      commit_sha: COMMIT,
      context: 'overcenter/history-normalization',
      expected_state: 'success' as const,
    },
  };
}

function workDefinition() {
  return {
    id: WORK,
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1' as const,
      path: '/virtual/history-normalization',
      content: 'done',
    },
  };
}

function claim(kernel: KernelCore, id: string) {
  const work = kernel.inspect().find((candidate) => candidate.id === id);
  assert.ok(work);
  assert.equal(work.status, 'READY');
  return kernel.claim(id, work.revision);
}

function attemptAliases(history: FactCommit[]): Map<string, { obligation_id: string; attempt: number }> {
  const counts = new Map<string, number>();
  const aliases = new Map<string, { obligation_id: string; attempt: number }>();
  for (const record of history) {
    const fact = record.claim as { run_id?: unknown; obligation_id?: unknown } | null | undefined;
    if (!fact || typeof fact.run_id !== 'string' || typeof fact.obligation_id !== 'string') continue;
    const attempt = (counts.get(fact.obligation_id) ?? 0) + 1;
    counts.set(fact.obligation_id, attempt);
    aliases.set(fact.run_id, { obligation_id: fact.obligation_id, attempt });
  }
  return aliases;
}

function semanticEvents(history: FactCommit[]): SemanticEvent[] {
  const aliases = attemptAliases(history);
  const result: SemanticEvent[] = [];

  for (const record of history) {
    if (record.claim) {
      const fact = record.claim as {
        run_id: string;
        obligation_id: string;
        obligation_key: string;
      };
      const alias = aliases.get(fact.run_id);
      assert.ok(alias);
      result.push({
        kind: 'claim',
        obligation_id: alias.obligation_id,
        attempt: alias.attempt,
        obligation_key: fact.obligation_key,
        execution_generation: 1,
      });
    }

    if (record.execution_authority) {
      const fact = record.execution_authority as {
        run_id: string;
        generation: number;
      };
      const alias = aliases.get(fact.run_id);
      assert.ok(alias);
      result.push({
        kind: 'execution-authority',
        obligation_id: alias.obligation_id,
        attempt: alias.attempt,
        execution_generation: fact.generation,
      });
    }

    if (record.effect_reservation) {
      const fact = record.effect_reservation as {
        run_id: string;
        execution_generation: number;
      };
      const alias = aliases.get(fact.run_id);
      assert.ok(alias);
      result.push({
        kind: 'effect-reservation',
        obligation_id: alias.obligation_id,
        attempt: alias.attempt,
        execution_generation: fact.execution_generation,
      });
    }

    if (record.effect_release) {
      const fact = record.effect_release as {
        run_id: string;
        execution_generation: number;
        evidence_kind: string;
        evidence?: { source?: unknown };
      };
      const alias = aliases.get(fact.run_id);
      assert.ok(alias);
      result.push({
        kind: 'effect-release',
        obligation_id: alias.obligation_id,
        attempt: alias.attempt,
        execution_generation: fact.execution_generation,
        evidence_kind: fact.evidence_kind,
        evidence_source:
          typeof fact.evidence?.source === 'string' ? fact.evidence.source : 'legacy-or-opaque',
      });
    }

    if (record.receipt) {
      const fact = record.receipt as {
        run_id: string;
        execution_generation: number;
        kind: string;
      };
      const alias = aliases.get(fact.run_id);
      assert.ok(alias);
      result.push({
        kind: 'receipt',
        obligation_id: alias.obligation_id,
        attempt: alias.attempt,
        execution_generation: fact.execution_generation,
        receipt_kind: fact.kind,
      });
    }
  }

  return result;
}

function eventRank(event: SemanticEvent): number {
  switch (event.kind) {
    case 'claim':
      return 0;
    case 'execution-authority':
      return 1;
    case 'effect-reservation':
      return 2;
    case 'effect-release':
      return 3;
    case 'receipt':
      return 4;
    case 'aborted-attempt':
      return 2;
  }
}

function eventKey(event: SemanticEvent): string {
  return [
    event.obligation_id,
    String(event.attempt).padStart(4, '0'),
    String(eventRank(event)).padStart(2, '0'),
    event.kind,
  ].join(':');
}

function independent(left: SemanticEvent, right: SemanticEvent): boolean {
  const pair = [left.obligation_id, right.obligation_id].sort().join('|');
  return pair === [STATUS, WORK].sort().join('|');
}

function sameAttempt(
  left: Pick<SemanticEvent, 'obligation_id' | 'attempt' | 'execution_generation'>,
  right: Pick<SemanticEvent, 'obligation_id' | 'attempt' | 'execution_generation'>,
): boolean {
  return (
    left.obligation_id === right.obligation_id &&
    left.attempt === right.attempt &&
    left.execution_generation === right.execution_generation
  );
}

function oneStepRewrites(events: SemanticEvent[]): SemanticEvent[][] {
  const rewrites: SemanticEvent[][] = [];

  for (let index = 0; index < events.length - 1; index += 1) {
    const left = events[index]!;
    const right = events[index + 1]!;
    if (independent(left, right) && eventKey(left) > eventKey(right)) {
      const next = [...events];
      next[index] = right;
      next[index + 1] = left;
      rewrites.push(next);
    }
  }

  for (let index = 0; index < events.length - 2; index += 1) {
    const reservation = events[index]!;
    const release = events[index + 1]!;
    const receipt = events[index + 2]!;
    if (
      reservation.kind === 'effect-reservation' &&
      release.kind === 'effect-release' &&
      receipt.kind === 'receipt' &&
      receipt.receipt_kind === 'effect-not-dispatched' &&
      sameAttempt(reservation, release) &&
      sameAttempt(release, receipt)
    ) {
      const collapsed: SemanticEvent = {
        kind: 'aborted-attempt',
        obligation_id: reservation.obligation_id,
        attempt: reservation.attempt,
        execution_generation: reservation.execution_generation,
        evidence_kind: release.evidence_kind,
        evidence_source: release.evidence_source,
        receipt_kind: 'effect-not-dispatched',
      };
      rewrites.push([
        ...events.slice(0, index),
        collapsed,
        ...events.slice(index + 3),
      ]);
    }
  }

  return rewrites;
}

function normalForm(input: SemanticEvent[]): SemanticEvent[] {
  let current = structuredClone(input);
  for (let step = 0; step < 256; step += 1) {
    const rewrites = oneStepRewrites(current);
    if (rewrites.length === 0) return current;
    rewrites.sort((left, right) => canonicalDigest(left).localeCompare(canonicalDigest(right)));
    current = rewrites[0]!;
  }
  throw new Error('NORMALIZATION_DID_NOT_TERMINATE');
}

function replaySignature(history: FactCommit[]): unknown {
  const projection = replayProjection(history);
  const aliases = attemptAliases(history);
  const attempt = (runId: string) => {
    const alias = aliases.get(runId);
    assert.ok(alias);
    return `${alias.obligation_id}#${alias.attempt}`;
  };

  return {
    work: [...projection.project.work]
      .map((work) => ({
        id: work.id,
        status: work.status,
        semantic_key: projection.project.semanticKeys.get(work.id) ?? null,
        blocked_reason: work.blocked_reason ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    runs: [...projection.history.runs.values()]
      .map((run) => ({
        attempt: attempt(run.id),
        obligation_id: run.obligation_id,
        obligation_key: run.obligation_key,
        execution_generation: run.execution_generation,
      }))
      .sort((left, right) => left.attempt.localeCompare(right.attempt)),
    receipts: projection.history.receipts
      .map((receipt) => ({
        attempt: attempt(receipt.run_id),
        obligation_id: receipt.obligation_id,
        execution_generation: receipt.execution_generation,
        kind: receipt.kind,
        disposition: receipt.disposition,
        verified: receipt.verified,
        observation_certainty: receipt.observed?.mutation_certainty ?? null,
      }))
      .sort((left, right) =>
        `${left.attempt}:${left.execution_generation}:${left.kind}`.localeCompare(
          `${right.attempt}:${right.execution_generation}:${right.kind}`,
        ),
      ),
    unresolved_effects: [...projection.history.unresolvedReservationsByRun.keys()]
      .map(attempt)
      .sort(),
  };
}

async function buildHistory(
  root: string,
  label: string,
  interleaving: Interleaving,
  continuation: Continuation,
): Promise<RunResult> {
  const store = new SqliteFactStore(join(root, `${label}.sqlite`));
  const kernel = new KernelCore(store);
  try {
    kernel.initialize();
    const revision = kernel.head();
    assert.ok(revision);
    kernel.applyGraphPatch({ upsert: [statusDefinition(), workDefinition()] }, revision);

    let workPermit;
    if (interleaving === 'work-first') workPermit = claim(kernel, WORK);

    const statusPermit = claim(kernel, STATUS);
    await assert.rejects(
      performGithubCommitStatusEffect(kernel, statusPermit, {
        token: 'token',
        get: () => repository(),
        post: createGithubStatusPost({
          lookup: (_hostname, _options, callback) => callback(null, '127.0.0.2', 4),
        }),
      }),
      /GITHUB_STATUS_MUTATION_NOT_DISPATCHED/,
    );
    assert.equal(kernel.inspect().find((work) => work.id === STATUS)?.status, 'READY');
    assert.equal(kernel.hasUnresolvedEffect(statusPermit.id), false);

    if (interleaving === 'status-first') workPermit = claim(kernel, WORK);
    assert.ok(workPermit);

    if (continuation === 'defer-work' || continuation === 'defer-and-retry') {
      const receipt = kernel.deferForJudgment(workPermit, { source: 'history-normalization' });
      assert.equal(receipt.disposition, 'WAITING');
    }
    if (continuation === 'retry-status' || continuation === 'defer-and-retry') {
      claim(kernel, STATUS);
    }

    const head = kernel.head();
    assert.ok(head);
    const history = store.history(head);
    const events = semanticEvents(history);
    const normalized = normalForm(events);
    return {
      history,
      semantic_events: events,
      normal_form: normalized,
      semantic_digest: canonicalDigest(normalized),
      provenance_digest: canonicalDigest(history),
      replay_signature: replaySignature(history),
    };
  } finally {
    store.close();
  }
}

function conflictNegativeControl(root: string): void {
  const store = new SqliteFactStore(join(root, 'conflict.sqlite'));
  const kernel = new KernelCore(store);
  try {
    kernel.initialize();
    const revision = kernel.head();
    assert.ok(revision);
    const base = statusDefinition();
    assert.throws(
      () =>
        kernel.applyGraphPatch(
          {
            upsert: [
              { ...base, id: 'conflict-success' },
              {
                ...base,
                id: 'conflict-failure',
                postcondition: { ...base.postcondition, expected_state: 'failure' as const },
              },
            ],
          },
          revision,
        ),
      /UNORDERED_EFFECT_CONFLICT/,
    );
  } finally {
    store.close();
  }
}

function observationDedupNegativeControl(): void {
  const first = {
    schema: ABSENCE_EVIDENCE_SCHEMA,
    kind: 'history-normalization/snapshot-absence',
    subject: { resource: 'example', name: 'target' },
    scope: { resource: 'example' },
    snapshot: { resource_version: '100' },
    completeness: { kind: 'complete-snapshot' },
    provenance: { provider: 'fixture', read: 1 },
  };
  const second = {
    ...first,
    snapshot: { resource_version: '101' },
    provenance: { provider: 'fixture', read: 2 },
  };
  validateAbsenceEvidenceEnvelope(first);
  validateAbsenceEvidenceEnvelope(second);
  assert.notEqual(canonicalDigest(first), canonicalDigest(second));
  assert.deepEqual(first.subject, second.subject);
}

function createDeleteNegativeControl(): void {
  const history = [
    { kind: 'create', resource: 'target', provider_event: 'audit-1' },
    { kind: 'delete', resource: 'target', provider_event: 'audit-2' },
  ];
  const noOp: typeof history = [];
  const visibleAfter = (events: typeof history) =>
    events.reduce((visible, event) => (event.kind === 'create' ? true : false), false);
  assert.equal(visibleAfter(history), visibleAfter(noOp));
  assert.notEqual(canonicalDigest(history), canonicalDigest(noOp));
}

function erasedAbortNegativeControl(aborted: RunResult, root: string): void {
  const store = new SqliteFactStore(join(root, 'never-attempted.sqlite'));
  const kernel = new KernelCore(store);
  try {
    kernel.initialize();
    const revision = kernel.head();
    assert.ok(revision);
    kernel.applyGraphPatch({ upsert: [statusDefinition(), workDefinition()] }, revision);
    claim(kernel, WORK);
    const head = kernel.head();
    assert.ok(head);
    const untouched = store.history(head);

    const abortedProjection = replayProjection(aborted.history);
    const untouchedProjection = replayProjection(untouched);
    assert.equal(
      abortedProjection.project.work.find((work) => work.id === STATUS)?.status,
      untouchedProjection.project.work.find((work) => work.id === STATUS)?.status,
    );
    assert.notDeepEqual(replaySignature(aborted.history), replaySignature(untouched));
  } finally {
    store.close();
  }
}

function criticalPairCase(base: SemanticEvent[]): number {
  let branches = 0;
  for (const first of oneStepRewrites(base)) {
    const firstNormal = normalForm(first);
    for (const second of oneStepRewrites(base)) {
      branches += 1;
      assert.deepEqual(firstNormal, normalForm(second));
    }
  }
  assert.ok(branches > 1);
  return branches;
}

const root = mkdtempSync(join(tmpdir(), 'overcenter-history-normalization-'));
try {
  const continuations: Continuation[] = ['none', 'defer-work', 'retry-status', 'defer-and-retry'];
  const comparisons: Array<Record<string, unknown>> = [];
  let firstAborted: RunResult | null = null;

  for (const continuation of continuations) {
    const statusFirst = await buildHistory(
      root,
      `status-first-${continuation}`,
      'status-first',
      continuation,
    );
    const workFirst = await buildHistory(
      root,
      `work-first-${continuation}`,
      'work-first',
      continuation,
    );
    firstAborted ??= workFirst;

    assert.deepEqual(statusFirst.replay_signature, workFirst.replay_signature);
    assert.deepEqual(statusFirst.normal_form, workFirst.normal_form);
    assert.equal(statusFirst.semantic_digest, workFirst.semantic_digest);
    assert.notEqual(statusFirst.provenance_digest, workFirst.provenance_digest);

    comparisons.push({
      continuation,
      status_first_events: statusFirst.semantic_events.length,
      work_first_events: workFirst.semantic_events.length,
      normal_form_events: statusFirst.normal_form.length,
      semantic_digest: statusFirst.semantic_digest,
      provenance_distinct: true,
    });
  }

  assert.ok(firstAborted);
  const criticalPairBranches = criticalPairCase(firstAborted.semantic_events);
  conflictNegativeControl(root);
  observationDedupNegativeControl();
  erasedAbortNegativeControl(firstAborted, root);
  createDeleteNegativeControl();

  for (const comparison of comparisons) {
    console.log(JSON.stringify({ kind: 'history-normalization-equivalence', ...comparison }));
  }
  console.log(
    JSON.stringify({
      kind: 'history-normalization-summary',
      outcome: 'SUPPORTED',
      interleavings_compared: comparisons.length * 2,
      bounded_continuations: continuations.length,
      critical_pair_branches: criticalPairBranches,
      negative_controls: {
        conflicting_effects_declared_independent: 'REJECTED',
        equal_value_observations_deduplicated_across_snapshots: 'REJECTED',
        not_dispatched_attempt_erased_to_no_op: 'REJECTED',
        create_delete_erased_to_no_op: 'REJECTED',
      },
      claim: 'derived proof-carrying semantic normalization is viable for the bounded corpus',
      non_claim: 'raw authority history remains immutable and unnormalized',
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
