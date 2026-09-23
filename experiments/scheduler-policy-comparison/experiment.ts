import assert from 'node:assert/strict';

import { RECEIPT_SCHEMA } from '../../src/authority/facts.ts';
import type { HistoricalRun, Receipt, State } from '../../src/authority/facts.ts';
import { deriveProjectProjection } from '../../src/authority/project-state.ts';
import { obligationKey } from '../../src/graph/identity.ts';
import type { Obligation } from '../../src/model.ts';

const WIDTHS = [1, 2, 4] as const;
const MAX_WAVES = 16;
const OLDER_FRESH_BACKLOG = 4;

type ClaimClass = 'fresh' | 'recovered';
type PolicyName = 'current-fresh-first' | 'recovered-first' | 'class-alternating' | 'service-age';

interface Event {
  ordinal: number;
  kind: 'admit' | 'claim';
  id: string;
  claim_class?: ClaimClass;
}

interface Harness {
  state: State;
  runs: Map<string, HistoricalRun>;
  receipts: Map<string, Receipt>;
  events: Event[];
  clock: number;
  runSequence: number;
}

interface ReplayMetadata {
  admissionOrdinal: Map<string, number>;
  lastClaimOrdinal: Map<string, number>;
  claimed: Set<string>;
  lastClaimClass: ClaimClass | null;
}

type Selector = (harness: Harness) => string | null;

function makeObligation(id: string): Obligation {
  return {
    id,
    dependencies: [],
    packet: {},
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/provider/' + id,
      content: id.toUpperCase(),
    },
  };
}

function makeHarness(): Harness {
  return {
    state: { obligations: {}, definition_ids: {} },
    runs: new Map(),
    receipts: new Map(),
    events: [],
    clock: 0,
    runSequence: 0,
  };
}

function appendEvent(harness: Harness, event: Omit<Event, 'ordinal'>): Event {
  harness.clock += 1;
  const recorded = { ...event, ordinal: harness.clock };
  harness.events.push(recorded);
  return recorded;
}

function addObligation(harness: Harness, id: string): void {
  assert.equal(harness.state.obligations[id], undefined);
  harness.state.obligations[id] = makeObligation(id);
  harness.state.definition_ids[id] = 'define-' + id;
  appendEvent(harness, { kind: 'admit', id });
}

function project(harness: Harness, label: string) {
  return deriveProjectProjection({
    state: harness.state,
    runs: harness.runs,
    receiptsByRun: harness.receipts,
    revision: label,
  });
}

function replayMetadata(events: readonly Event[]): ReplayMetadata {
  const admissionOrdinal = new Map<string, number>();
  const lastClaimOrdinal = new Map<string, number>();
  const claimed = new Set<string>();
  let lastClaimClass: ClaimClass | null = null;

  for (const event of events) {
    if (event.kind === 'admit') {
      assert.equal(admissionOrdinal.has(event.id), false);
      admissionOrdinal.set(event.id, event.ordinal);
      continue;
    }
    assert.ok(event.claim_class);
    claimed.add(event.id);
    lastClaimOrdinal.set(event.id, event.ordinal);
    lastClaimClass = event.claim_class;
  }

  return { admissionOrdinal, lastClaimOrdinal, claimed, lastClaimClass };
}

function readyIds(harness: Harness): string[] {
  return project(harness, 'selection-' + harness.clock)
    .work.filter((work) => work.status === 'READY')
    .map((work) => work.id);
}

function recordReadyClaim(harness: Harness, id: string, label: string): void {
  const before = project(harness, label + '-before');
  const obligation = harness.state.obligations[id];
  assert.ok(obligation);
  assert.equal(before.work.find((work) => work.id === id)?.status, 'READY');

  const key = obligationKey(harness.state, obligation, before.lifecycles, harness.receipts);
  assert.ok(key);

  const replayed = replayMetadata(harness.events);
  const claimClass: ClaimClass = replayed.claimed.has(id) ? 'recovered' : 'fresh';
  const event = appendEvent(harness, { kind: 'claim', id, claim_class: claimClass });

  harness.runSequence += 1;
  const runId = 'run-' + harness.runSequence + '-' + id;
  const claimCommit = 'claim-' + event.ordinal + '-' + id;
  const run: HistoricalRun = {
    id: runId,
    obligation_id: id,
    claimed_revision: label,
    claim_commit: claimCommit,
    obligation_key: key,
    execution_generation: harness.runSequence,
    execution_authority_commit: claimCommit,
    execution_capability_sha256: '0'.repeat(64),
    obligation,
    definition_id: 'define-' + id,
  };
  harness.runs.set(runId, run);
  harness.receipts.set(runId, {
    schema: RECEIPT_SCHEMA,
    run_id: runId,
    obligation_id: id,
    claimed_revision: label,
    claim_commit: claimCommit,
    execution_generation: harness.runSequence,
    execution_authority_commit: claimCommit,
    kind: 'observation',
    observed: null,
    settled_at: '2026-09-23T00:00:00.000Z',
    disposition: 'READY',
    verified: false,
  } as Receipt);
}

function chooseCurrent(harness: Harness): string | null {
  return project(harness, 'current-' + harness.clock).readyWork?.id ?? null;
}

function chooseRecoveredFirst(harness: Harness): string | null {
  const meta = replayMetadata(harness.events);
  return (
    readyIds(harness).sort((a, b) => {
      const aRecovered = meta.claimed.has(a) ? 0 : 1;
      const bRecovered = meta.claimed.has(b) ? 0 : 1;
      if (aRecovered !== bRecovered) return aRecovered - bRecovered;
      if (aRecovered === 0) {
        return (
          (meta.lastClaimOrdinal.get(a) ?? Number.MAX_SAFE_INTEGER) -
            (meta.lastClaimOrdinal.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b)
        );
      }
      return a.localeCompare(b);
    })[0] ?? null
  );
}

function chooseClassAlternating(harness: Harness): string | null {
  const meta = replayMetadata(harness.events);
  const ready = readyIds(harness);
  const fresh = ready.filter((id) => !meta.claimed.has(id)).sort();
  const recovered = ready
    .filter((id) => meta.claimed.has(id))
    .sort(
      (a, b) =>
        (meta.lastClaimOrdinal.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (meta.lastClaimOrdinal.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b),
    );

  if (fresh.length > 0 && recovered.length > 0) {
    return meta.lastClaimClass === 'fresh' ? recovered[0]! : fresh[0]!;
  }
  return fresh[0] ?? recovered[0] ?? null;
}

function chooseServiceAge(harness: Harness): string | null {
  const meta = replayMetadata(harness.events);
  return (
    readyIds(harness).sort((a, b) => {
      const aAge = meta.lastClaimOrdinal.get(a) ?? meta.admissionOrdinal.get(a);
      const bAge = meta.lastClaimOrdinal.get(b) ?? meta.admissionOrdinal.get(b);
      assert.notEqual(aAge, undefined);
      assert.notEqual(bAge, undefined);
      return aAge! - bAge! || a.localeCompare(b);
    })[0] ?? null
  );
}

const POLICIES: Record<PolicyName, Selector> = {
  'current-fresh-first': chooseCurrent,
  'recovered-first': chooseRecoveredFirst,
  'class-alternating': chooseClassAlternating,
  'service-age': chooseServiceAge,
};

function runRecoveredTargetFreshFlood(policy: Selector, width: number): number | null {
  const harness = makeHarness();
  addObligation(harness, 'recovered-target');
  recordReadyClaim(harness, 'recovered-target', 'seed-target');

  let selections = 0;
  let arrival = 0;
  for (let wave = 0; wave < MAX_WAVES; wave += 1) {
    for (let slot = 0; slot < width; slot += 1) {
      addObligation(harness, 'fresh-' + String(arrival).padStart(4, '0'));
      arrival += 1;
    }
    for (let slot = 0; slot < width; slot += 1) {
      const selected = policy(harness);
      assert.ok(selected);
      selections += 1;
      if (selected === 'recovered-target') return selections;
      recordReadyClaim(harness, selected, 'fresh-flood-' + selections);
    }
  }
  return null;
}

function runFreshTargetRecoveryPressure(policy: Selector, width: number): number | null {
  const harness = makeHarness();
  addObligation(harness, 'hot-recovered');
  recordReadyClaim(harness, 'hot-recovered', 'seed-hot');
  addObligation(harness, 'fresh-target');

  let selections = 0;
  for (let wave = 0; wave < MAX_WAVES; wave += 1) {
    for (let slot = 0; slot < width; slot += 1) {
      const selected = policy(harness);
      assert.ok(selected);
      selections += 1;
      if (selected === 'fresh-target') return selections;
      recordReadyClaim(harness, selected, 'recovery-pressure-' + selections);
    }
  }
  return null;
}

function runOlderFreshTargetYoungerFlood(policy: Selector, width: number): number | null {
  const harness = makeHarness();
  for (let index = 0; index < OLDER_FRESH_BACKLOG; index += 1) {
    addObligation(harness, 'old-' + String(index).padStart(2, '0'));
  }
  addObligation(harness, 'zz-target');

  let selections = 0;
  let arrival = 0;
  for (let wave = 0; wave < MAX_WAVES; wave += 1) {
    for (let slot = 0; slot < width; slot += 1) {
      addObligation(harness, 'aa-arrival-' + String(arrival).padStart(4, '0'));
      arrival += 1;
    }
    for (let slot = 0; slot < width; slot += 1) {
      const selected = policy(harness);
      assert.ok(selected);
      selections += 1;
      if (selected === 'zz-target') return selections;
      recordReadyClaim(harness, selected, 'younger-flood-' + selections);
    }
  }
  return null;
}

interface Result {
  policy: PolicyName;
  width: number;
  recovered_target_fresh_flood: number | null;
  fresh_target_recovery_pressure: number | null;
  older_fresh_target_younger_flood: number | null;
}

const results: Result[] = [];
for (const [policy, selector] of Object.entries(POLICIES) as Array<[PolicyName, Selector]>) {
  for (const width of WIDTHS) {
    results.push({
      policy,
      width,
      recovered_target_fresh_flood: runRecoveredTargetFreshFlood(selector, width),
      fresh_target_recovery_pressure: runFreshTargetRecoveryPressure(selector, width),
      older_fresh_target_younger_flood: runOlderFreshTargetYoungerFlood(selector, width),
    });
  }
}

for (const width of WIDTHS) {
  const byPolicy = new Map(
    results.filter((result) => result.width === width).map((result) => [result.policy, result]),
  );

  const current = byPolicy.get('current-fresh-first')!;
  assert.equal(current.recovered_target_fresh_flood, null);
  assert.notEqual(current.fresh_target_recovery_pressure, null);
  assert.equal(current.older_fresh_target_younger_flood, null);

  const recovered = byPolicy.get('recovered-first')!;
  assert.notEqual(recovered.recovered_target_fresh_flood, null);
  assert.equal(recovered.fresh_target_recovery_pressure, null);
  assert.equal(recovered.older_fresh_target_younger_flood, null);

  const alternating = byPolicy.get('class-alternating')!;
  assert.notEqual(alternating.recovered_target_fresh_flood, null);
  assert.notEqual(alternating.fresh_target_recovery_pressure, null);
  assert.equal(alternating.older_fresh_target_younger_flood, null);

  const age = byPolicy.get('service-age')!;
  assert.equal(age.recovered_target_fresh_flood, 1);
  assert.equal(age.fresh_target_recovery_pressure, 2);
  assert.equal(age.older_fresh_target_younger_flood, OLDER_FRESH_BACKLOG + 1);
}

for (const result of results) {
  console.log(JSON.stringify({ kind: 'scheduler-policy-case', ...result }));
}

console.log(
  JSON.stringify({
    kind: 'scheduler-policy-summary',
    service_age_passes_all_hostile_cases: true,
    service_age_requires_mutable_cursor: false,
    service_age_metadata: 'derived admission ordinal or last-claim ordinal',
  }),
);
