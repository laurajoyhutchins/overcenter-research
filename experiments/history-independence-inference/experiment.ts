import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateAdmission } from '../../src/authority/admission.ts';
import { KernelCore } from '../../src/authority/engine.ts';
import type { FactCommit, State } from '../../src/authority/facts.ts';
import { replayProjection } from '../../src/authority/replay.ts';
import { canonicalDigest } from '../../src/digest.ts';
import {
  effectAdapterCapabilities,
  GITHUB_COMMIT_STATUS_EFFECT,
} from '../../src/effect-adapter.ts';
import { buildGraphIndex, graphDependsOn } from '../../src/graph/topology.ts';
import type { ExecutionPermit, Obligation } from '../../src/model.ts';
import {
  createGithubStatusPost,
  performGithubCommitStatusEffect,
} from '../../src/providers/github/status-effect.ts';
import { effectSemantics } from '../../src/semantics.ts';
import { SqliteFactStore } from '../../src/storage/sqlite.ts';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const A = 'a-status';
const B = 'b-status';

type Order = 'a-first' | 'b-first';
type Action =
  | 'claim-a'
  | 'claim-b'
  | 'acquire-a'
  | 'acquire-b'
  | 'defer-a'
  | 'defer-b';

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

interface IndependenceDecision {
  independent: boolean;
  reason:
    | 'same-obligation'
    | 'graph-causal'
    | 'effect-semantics-unknown'
    | 'effect-adapter-unknown-or-mismatched'
    | 'distinct-effect-resource'
    | 'same-resource-different-desired'
    | 'same-resource-duplicate-delivery-not-proven'
    | 'same-resource-semantically-idempotent';
}

interface SuccessfulHistory {
  ok: true;
  history: FactCommit[];
  events: SemanticEvent[];
  normal_form: SemanticEvent[];
  semantic_digest: string;
  provenance_digest: string;
  replay_signature: unknown;
  state: State;
}

interface FailedHistory {
  ok: false;
  error: string;
}

type HistoryResult = SuccessfulHistory | FailedHistory;

function status(
  id: string,
  {
    context,
    commit = COMMIT_A,
    expectedState = 'success',
    dependencies = [],
  }: {
    context: string;
    commit?: string;
    expectedState?: 'failure' | 'success';
    dependencies?: Obligation['dependencies'];
  },
): Obligation {
  return {
    id,
    dependencies,
    packet: { effect_contract: GITHUB_COMMIT_STATUS_EFFECT },
    postcondition: {
      verifier: 'github-commit-status/v2',
      provider: 'github',
      repository_id: 42,
      repository_full_name: 'acme/widget',
      commit_sha: commit,
      context,
      expected_state: expectedState,
    },
  };
}

function unknownEffect(id: string): Obligation {
  return {
    id,
    dependencies: [],
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/virtual/' + id,
      content: 'done',
    },
  };
}

function stateOf(obligations: Obligation[]): State {
  return {
    obligations: Object.fromEntries(obligations.map((obligation) => [obligation.id, obligation])),
    definition_ids: Object.fromEntries(obligations.map((obligation) => [obligation.id, 'fixture'])),
  };
}

function deriveProjectTruthIndependence(
  state: State,
  leftId: string,
  rightId: string,
): IndependenceDecision {
  if (leftId === rightId) return { independent: false, reason: 'same-obligation' };

  const graph = buildGraphIndex(state);
  if (graphDependsOn(graph, leftId, rightId) || graphDependsOn(graph, rightId, leftId)) {
    return { independent: false, reason: 'graph-causal' };
  }

  const left = state.obligations[leftId];
  const right = state.obligations[rightId];
  assert.ok(left);
  assert.ok(right);
  const leftEffect = effectSemantics(left.postcondition);
  const rightEffect = effectSemantics(right.postcondition);
  if (!leftEffect || !rightEffect) {
    return { independent: false, reason: 'effect-semantics-unknown' };
  }

  const leftCapabilities = effectAdapterCapabilities(left.packet.effect_contract);
  const rightCapabilities = effectAdapterCapabilities(right.packet.effect_contract);
  if (
    !leftCapabilities ||
    !rightCapabilities ||
    leftCapabilities.postcondition_verifier !== left.postcondition.verifier ||
    rightCapabilities.postcondition_verifier !== right.postcondition.verifier
  ) {
    return { independent: false, reason: 'effect-adapter-unknown-or-mismatched' };
  }

  if (leftEffect.resource !== rightEffect.resource) {
    return { independent: true, reason: 'distinct-effect-resource' };
  }
  if (leftEffect.desired !== rightEffect.desired) {
    return { independent: false, reason: 'same-resource-different-desired' };
  }

  if (
    leftEffect.sameDesiredCommutes &&
    rightEffect.sameDesiredCommutes &&
    leftCapabilities?.duplicate_delivery === 'semantically-idempotent' &&
    rightCapabilities?.duplicate_delivery === 'semantically-idempotent'
  ) {
    return { independent: true, reason: 'same-resource-semantically-idempotent' };
  }
  return { independent: false, reason: 'same-resource-duplicate-delivery-not-proven' };
}

function manualOracleCases() {
  const a = status(A, { context: 'overcenter/history-inference/a' });
  const b = status(B, { context: 'overcenter/history-inference/b' });
  const differentCommit = status('different-commit', {
    context: 'overcenter/history-inference/a',
    commit: COMMIT_B,
  });
  const dependent = status('dependent', {
    context: 'overcenter/history-inference/dependent',
    dependencies: [{ kind: 'control', upstream: A }],
  });
  const sameDesired = status('same-desired', { context: 'overcenter/history-inference/a' });
  const conflicting = status('conflicting', {
    context: 'overcenter/history-inference/a',
    expectedState: 'failure',
  });
  const unknown = unknownEffect('unknown-effect');
  const mismatchedAdapter = status('mismatched-adapter', {
    context: 'overcenter/history-inference/mismatched-adapter',
  });
  mismatchedAdapter.packet.effect_contract = 'provider/unknown-effect';

  return [
    {
      name: 'different-coordinate',
      state: stateOf([a, b]),
      left: A,
      right: B,
      expected: true,
    },
    {
      name: 'different-commit',
      state: stateOf([a, differentCommit]),
      left: A,
      right: differentCommit.id,
      expected: true,
    },
    {
      name: 'graph-dependency',
      state: stateOf([a, dependent]),
      left: A,
      right: dependent.id,
      expected: false,
    },
    {
      name: 'same-coordinate-same-desired-may-duplicate',
      state: stateOf([a, sameDesired]),
      left: A,
      right: sameDesired.id,
      expected: false,
    },
    {
      name: 'same-coordinate-conflicting-desired',
      state: stateOf([a, conflicting]),
      left: A,
      right: conflicting.id,
      expected: false,
    },
    {
      name: 'unknown-effect-semantics',
      state: stateOf([a, unknown]),
      left: A,
      right: unknown.id,
      expected: false,
    },
    {
      name: 'mismatched-effect-adapter',
      state: stateOf([a, mismatchedAdapter]),
      left: A,
      right: mismatchedAdapter.id,
      expected: false,
    },
  ];
}

function noGraphGuard(state: State, leftId: string, rightId: string): boolean {
  const left = effectSemantics(state.obligations[leftId]!.postcondition);
  const right = effectSemantics(state.obligations[rightId]!.postcondition);
  return Boolean(left && right && left.resource !== right.resource);
}

function resourceBlind(state: State, leftId: string, rightId: string): boolean {
  const graph = buildGraphIndex(state);
  if (graphDependsOn(graph, leftId, rightId) || graphDependsOn(graph, rightId, leftId)) return false;
  return Boolean(
    effectSemantics(state.obligations[leftId]!.postcondition) &&
      effectSemantics(state.obligations[rightId]!.postcondition),
  );
}

function unknownMeansIndependent(state: State, leftId: string, rightId: string): boolean {
  const graph = buildGraphIndex(state);
  if (graphDependsOn(graph, leftId, rightId) || graphDependsOn(graph, rightId, leftId)) return false;
  const left = effectSemantics(state.obligations[leftId]!.postcondition);
  const right = effectSemantics(state.obligations[rightId]!.postcondition);
  if (!left || !right) return true;
  return left.resource !== right.resource;
}

function ignoresAdapterBinding(state: State, leftId: string, rightId: string): boolean {
  const graph = buildGraphIndex(state);
  if (graphDependsOn(graph, leftId, rightId) || graphDependsOn(graph, rightId, leftId)) return false;
  const left = effectSemantics(state.obligations[leftId]!.postcondition);
  const right = effectSemantics(state.obligations[rightId]!.postcondition);
  return Boolean(left && right && left.resource !== right.resource);
}

function sameDesiredCommutesMeansIndependent(
  state: State,
  leftId: string,
  rightId: string,
): boolean {
  const graph = buildGraphIndex(state);
  if (graphDependsOn(graph, leftId, rightId) || graphDependsOn(graph, rightId, leftId)) return false;
  const left = effectSemantics(state.obligations[leftId]!.postcondition);
  const right = effectSemantics(state.obligations[rightId]!.postcondition);
  if (!left || !right) return false;
  return (
    left.resource !== right.resource ||
    (left.resource === right.resource &&
      left.desired === right.desired &&
      left.sameDesiredCommutes &&
      right.sameDesiredCommutes)
  );
}

function checkInferenceAgainstManualOracle() {
  const cases = manualOracleCases();
  for (const fixture of cases) {
    assert.equal(
      deriveProjectTruthIndependence(fixture.state, fixture.left, fixture.right).independent,
      fixture.expected,
      fixture.name,
    );
  }

  const byName = new Map(cases.map((fixture) => [fixture.name, fixture]));
  const dependent = byName.get('graph-dependency')!;
  const conflict = byName.get('same-coordinate-conflicting-desired')!;
  const unknown = byName.get('unknown-effect-semantics')!;
  const sameDesired = byName.get('same-coordinate-same-desired-may-duplicate')!;
  const mismatchedAdapter = byName.get('mismatched-effect-adapter')!;

  assert.equal(noGraphGuard(dependent.state, dependent.left, dependent.right), true);
  assert.equal(resourceBlind(conflict.state, conflict.left, conflict.right), true);
  assert.equal(unknownMeansIndependent(unknown.state, unknown.left, unknown.right), true);
  assert.equal(
    sameDesiredCommutesMeansIndependent(sameDesired.state, sameDesired.left, sameDesired.right),
    true,
  );
  assert.equal(
    ignoresAdapterBinding(
      mismatchedAdapter.state,
      mismatchedAdapter.left,
      mismatchedAdapter.right,
    ),
    true,
  );

  assert.doesNotThrow(() => validateAdmission(sameDesired.state));
  assert.throws(() => validateAdmission(conflict.state), /UNORDERED_EFFECT_CONFLICT/);

  return {
    cases: cases.map((fixture) => ({
      name: fixture.name,
      expected: fixture.expected,
      decision: deriveProjectTruthIndependence(fixture.state, fixture.left, fixture.right),
    })),
    hostile_mutants_rejected: 5,
  };
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

function actualDefinitions(): [Obligation, Obligation] {
  return [
    status(A, { context: 'overcenter/history-inference/a' }),
    status(B, { context: 'overcenter/history-inference/b' }),
  ];
}

function claim(kernel: KernelCore, id: string): ExecutionPermit {
  const work = kernel.inspect().find((candidate) => candidate.id === id);
  assert.ok(work);
  assert.equal(work.status, 'READY');
  return kernel.claim(id, work.revision);
}

async function abortStatus(kernel: KernelCore, id: string): Promise<void> {
  const permit = claim(kernel, id);
  await assert.rejects(
    performGithubCommitStatusEffect(kernel, permit, {
      token: 'token',
      get: () => repository(),
      post: createGithubStatusPost({
        lookup: (_hostname, _options, callback) => callback(null, '127.0.0.2', 4),
      }),
    }),
    /GITHUB_STATUS_MUTATION_NOT_DISPATCHED/,
  );
  assert.equal(kernel.inspect().find((work) => work.id === id)?.status, 'READY');
  assert.equal(kernel.hasUnresolvedEffect(permit.id), false);
}

function aliases(history: FactCommit[]): Map<string, { obligation_id: string; attempt: number }> {
  const counts = new Map<string, number>();
  const result = new Map<string, { obligation_id: string; attempt: number }>();
  for (const record of history) {
    const claimFact = record.claim as
      | { run_id?: unknown; obligation_id?: unknown }
      | null
      | undefined;
    if (
      !claimFact ||
      typeof claimFact.run_id !== 'string' ||
      typeof claimFact.obligation_id !== 'string'
    )
      continue;
    const attempt = (counts.get(claimFact.obligation_id) ?? 0) + 1;
    counts.set(claimFact.obligation_id, attempt);
    result.set(claimFact.run_id, { obligation_id: claimFact.obligation_id, attempt });
  }
  return result;
}

function semanticEvents(history: FactCommit[]): SemanticEvent[] {
  const runAliases = aliases(history);
  const result: SemanticEvent[] = [];

  for (const record of history) {
    if (record.claim) {
      const fact = record.claim as {
        run_id: string;
        obligation_key: string;
      };
      const alias = runAliases.get(fact.run_id);
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
      const alias = runAliases.get(fact.run_id);
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
      const alias = runAliases.get(fact.run_id);
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
      const alias = runAliases.get(fact.run_id);
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
      const alias = runAliases.get(fact.run_id);
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

function oneStepRewrites(events: SemanticEvent[], state: State): SemanticEvent[][] {
  const rewrites: SemanticEvent[][] = [];
  for (let index = 0; index < events.length - 1; index += 1) {
    const left = events[index]!;
    const right = events[index + 1]!;
    if (
      deriveProjectTruthIndependence(state, left.obligation_id, right.obligation_id).independent &&
      eventKey(left) > eventKey(right)
    ) {
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
      rewrites.push([
        ...events.slice(0, index),
        {
          kind: 'aborted-attempt',
          obligation_id: reservation.obligation_id,
          attempt: reservation.attempt,
          execution_generation: reservation.execution_generation,
          evidence_kind: release.evidence_kind,
          evidence_source: release.evidence_source,
          receipt_kind: 'effect-not-dispatched',
        },
        ...events.slice(index + 3),
      ]);
    }
  }
  return rewrites;
}

function normalForm(events: SemanticEvent[], state: State): SemanticEvent[] {
  let current = structuredClone(events);
  for (let step = 0; step < 512; step += 1) {
    const next = oneStepRewrites(current, state);
    if (next.length === 0) return current;
    next.sort((left, right) => canonicalDigest(left).localeCompare(canonicalDigest(right)));
    current = next[0]!;
  }
  throw new Error('NORMALIZATION_DID_NOT_TERMINATE');
}

function replaySignature(history: FactCommit[]): unknown {
  const projection = replayProjection(history);
  const runAliases = aliases(history);
  const attemptName = (runId: string) => {
    const alias = runAliases.get(runId);
    assert.ok(alias);
    return alias.obligation_id + '#' + String(alias.attempt);
  };
  return {
    work: [...projection.project.work]
      .map((work) => ({
        id: work.id,
        status: work.status,
        semantic_key: projection.project.semanticKeys.get(work.id) ?? null,
        claimability: projection.project.claimabilityErrors.get(work.id) ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    runs: [...projection.history.runs.values()]
      .map((run) => ({
        attempt: attemptName(run.id),
        obligation_id: run.obligation_id,
        obligation_key: run.obligation_key,
        execution_generation: run.execution_generation,
      }))
      .sort((left, right) => left.attempt.localeCompare(right.attempt)),
    receipts: projection.history.receipts
      .map((receipt) => ({
        attempt: attemptName(receipt.run_id),
        obligation_id: receipt.obligation_id,
        execution_generation: receipt.execution_generation,
        kind: receipt.kind,
        disposition: receipt.disposition,
        verified: receipt.verified,
      }))
      .sort((left, right) =>
        (left.attempt + ':' + left.kind).localeCompare(right.attempt + ':' + right.kind),
      ),
    unresolved_effects: [...projection.history.unresolvedReservationsByRun.keys()]
      .map(attemptName)
      .sort(),
  };
}

function actionSequences(maxDepth: number): Action[][] {
  const alphabet: Action[] = [
    'claim-a',
    'claim-b',
    'acquire-a',
    'acquire-b',
    'defer-a',
    'defer-b',
  ];
  const result: Action[][] = [[]];
  let frontier: Action[][] = [[]];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next: Action[][] = [];
    for (const prefix of frontier) {
      for (const action of alphabet) {
        const sequence = [...prefix, action];
        next.push(sequence);
        result.push(sequence);
      }
    }
    frontier = next;
  }
  return result;
}

function applyActions(
  kernel: KernelCore,
  permits: Map<string, ExecutionPermit>,
  actions: Action[],
): void {
  for (const action of actions) {
    const id = action.endsWith('-a') ? A : B;
    if (action.startsWith('claim-')) {
      permits.set(id, claim(kernel, id));
      continue;
    }
    const permit = permits.get(id);
    if (!permit) throw new Error('CONTINUATION_PERMIT_MISSING:' + id);
    if (action.startsWith('acquire-')) {
      permits.set(id, kernel.acquireExecution(permit.id));
      continue;
    }
    kernel.deferForJudgment(permit, { source: 'history-independence-inference' });
  }
}

async function runHistory(
  root: string,
  label: string,
  order: Order,
  actions: Action[],
): Promise<HistoryResult> {
  const store = new SqliteFactStore(join(root, label + '.sqlite'));
  const kernel = new KernelCore(store);
  try {
    kernel.initialize();
    const revision = kernel.head();
    assert.ok(revision);
    kernel.applyGraphPatch({ upsert: actualDefinitions() }, revision);
    for (const id of order === 'a-first' ? [A, B] : [B, A]) {
      await abortStatus(kernel, id);
    }

    const permits = new Map<string, ExecutionPermit>();
    try {
      applyActions(kernel, permits, actions);
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    const head = kernel.head();
    assert.ok(head);
    const history = store.history(head);
    const projection = replayProjection(history);
    const events = semanticEvents(history);
    const normalized = normalForm(events, projection.state);
    return {
      ok: true,
      history,
      events,
      normal_form: normalized,
      semantic_digest: canonicalDigest(normalized),
      provenance_digest: canonicalDigest(history),
      replay_signature: replaySignature(history),
      state: projection.state,
    };
  } finally {
    store.close();
  }
}

function checkCriticalPairs(base: SuccessfulHistory): number {
  const firstSteps = oneStepRewrites(base.events, base.state);
  assert.ok(firstSteps.length > 1);
  const expected = base.normal_form;
  for (const candidate of firstSteps) {
    assert.deepEqual(normalForm(candidate, base.state), expected);
  }
  return firstSteps.length;
}


async function successfulProviderAuditCounterexample(root: string) {
  async function run(label: string, order: Order) {
    const store = new SqliteFactStore(join(root, 'provider-audit-' + label + '.sqlite'));
    const providerAudit: string[] = [];
    const providerContexts = new Set<string>();
    const observedAt = '2026-09-23T21:00:00.000Z';
    const get = (_token: string, path: string) => {
      if (path === '/repos/acme/widget') return repository();
      if (path === `/repos/acme/widget/commits/${COMMIT_A}/status?page=1&per_page=100`) {
        const statuses = [...providerContexts].map((context, index) => ({
          id: index + 1,
          node_id: 'STATUS_' + String(index + 1),
          state: 'success' as const,
          context,
          target_url: null,
          created_at: observedAt,
          updated_at: observedAt,
        }));
        return {
          state: 'success',
          sha: COMMIT_A,
          total_count: statuses.length,
          repository: repository(),
          statuses,
        };
      }
      throw new Error('UNEXPECTED_GITHUB_GET:' + path);
    };
    const kernel = new KernelCore(store, {
      githubToken: 'token',
      observationContext: { githubGet: get, clock: () => observedAt },
    });
    try {
      kernel.initialize();
      const revision = kernel.head();
      assert.ok(revision);
      kernel.applyGraphPatch({ upsert: actualDefinitions() }, revision);

      for (const id of order === 'a-first' ? [A, B] : [B, A]) {
        const permit = claim(kernel, id);
        await performGithubCommitStatusEffect(kernel, permit, {
          token: 'token',
          get,
          post: async (_token, _path, body) => {
            const context = String(body.context);
            providerAudit.push(context);
            providerContexts.add(context);
            return { status: 201, body: '{}' };
          },
        });
        const settled = kernel.resolve(permit, {
          source: 'history-independence-provider-audit',
        });
        assert.equal(settled.disposition, 'DONE');
        assert.equal(settled.verified, true);
      }

      assert.deepEqual(
        kernel
          .inspect()
          .map((work) => ({ id: work.id, status: work.status }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        [
          { id: A, status: 'DONE' },
          { id: B, status: 'DONE' },
        ],
      );

      const head = kernel.head();
      assert.ok(head);
      const history = store.history(head);
      const projection = replayProjection(history);
      const events = semanticEvents(history);
      return {
        provider_audit: providerAudit,
        replay_signature: replaySignature(history),
        normal_form: normalForm(events, projection.state),
      };
    } finally {
      store.close();
    }
  }

  const left = await run('a-first', 'a-first');
  const right = await run('b-first', 'b-first');
  assert.deepEqual(left.replay_signature, right.replay_signature);
  assert.deepEqual(left.normal_form, right.normal_form);
  assert.notDeepEqual(left.provider_audit, right.provider_audit);

  return {
    project_truth_equivalent: true,
    provider_audit_equivalent: false,
    a_first_audit: left.provider_audit,
    b_first_audit: right.provider_audit,
  };
}

const root = mkdtempSync(join(tmpdir(), 'overcenter-history-independence-inference-'));
try {
  const inference = checkInferenceAgainstManualOracle();
  const providerLens = await successfulProviderAuditCounterexample(root);
  const sequences = actionSequences(3);
  let legal = 0;
  let illegal = 0;
  let criticalPairBranches = 0;
  let baseSeen = false;

  for (let index = 0; index < sequences.length; index += 1) {
    const actions = sequences[index]!;
    const left = await runHistory(root, 'left-' + String(index), 'a-first', actions);
    const right = await runHistory(root, 'right-' + String(index), 'b-first', actions);

    assert.equal(
      left.ok,
      right.ok,
      'continuation legality diverged for ' + JSON.stringify(actions),
    );
    if (!left.ok || !right.ok) {
      assert.equal(
        (left as FailedHistory).error,
        (right as FailedHistory).error,
        'continuation rejection diverged for ' + JSON.stringify(actions),
      );
      illegal += 1;
      continue;
    }

    legal += 1;
    assert.deepEqual(left.replay_signature, right.replay_signature);
    assert.deepEqual(left.normal_form, right.normal_form);
    assert.equal(left.semantic_digest, right.semantic_digest);
    assert.notEqual(left.provenance_digest, right.provenance_digest);

    if (!baseSeen && actions.length === 0) {
      criticalPairBranches = checkCriticalPairs(left);
      baseSeen = true;
    }
  }

  assert.ok(baseSeen);
  console.log(
    JSON.stringify({
      kind: 'history-independence-inference-oracle',
      cases: inference.cases,
      hostile_mutants_rejected: inference.hostile_mutants_rejected,
    }),
  );
  console.log(
    JSON.stringify({
      kind: 'history-independence-inference-summary',
      outcome: 'SUPPORTED',
      candidate_relation: {
        lens: 'project-truth',
        graph_causality_required: true,
        known_effect_semantics_required: true,
        exact_adapter_verifier_binding_required: true,
        distinct_effect_resource_admitted: true,
        same_resource_requires_semantic_idempotence: true,
      },
      provider_lens_counterexample: providerLens,
      continuation_sequences_examined: sequences.length,
      legal_in_both_histories: legal,
      illegal_in_both_histories: illegal,
      asymmetric_legality: 0,
      critical_pair_branches: criticalPairBranches,
      provenance_preserved: true,
      hostile_inference_mutants_rejected: 5,
      non_claim:
        'the derived relation is project-truth-relative; distinct effect resources do not establish provider-history independence',
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
