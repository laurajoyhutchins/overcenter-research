import assert from 'node:assert/strict';

import {
  analyzeAdapterProtocol,
  boundedAmbiguousObservationSequences,
  releaseDecision,
  type AdapterProtocol,
} from '../../scripts/adapter-diagnosability.ts';
import {
  effectAdapterCapabilities,
  GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
} from '../../src/effect-adapter.ts';
import type { Postcondition } from '../../src/model.ts';
import {
  authoritativeAbsenceEvidence,
  observationVerified,
  observePostcondition,
} from '../../src/observation/observe.ts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const NEXT = 'c'.repeat(40);

function boundedCompletionProtocol(): AdapterProtocol {
  return {
    id: 'github-pr-update-branch-bounded-completion',
    initial: 's',
    states: [
      { id: 's', mutation: 'not-occurred' },
      { id: 'q', mutation: 'not-occurred' },
      { id: 'c', mutation: 'occurred' },
      { id: 'n', mutation: 'not-occurred' },
    ],
    transitions: [
      {
        from: 's',
        to: 'q',
        event: 'put-update-branch',
        observation: 'GITHUB_PR_UPDATE_BRANCH_ACCEPTED:202',
      },
      { from: 'q', to: 'c', event: 'provider-applies-update' },
      { from: 'q', to: 'n', event: 'provider-abandons-update' },
      { from: 'q', to: 'q', event: 'readback', observation: 'HEAD_UNCHANGED' },
      { from: 'n', to: 'n', event: 'readback', observation: 'HEAD_UNCHANGED' },
      { from: 'c', to: 'c', event: 'readback', observation: 'UPDATE_PROVED' },
      {
        from: 'q',
        to: 'q',
        event: 'release-reservation',
        observation: 'RELEASED',
        consequential: 'release-authority',
      },
      {
        from: 'n',
        to: 'n',
        event: 'release-reservation',
        observation: 'RELEASED',
        consequential: 'release-authority',
      },
      {
        from: 'c',
        to: 'c',
        event: 'settle',
        observation: 'DONE',
        consequential: 'settle-done',
      },
    ],
  };
}

function unboundedPendingProtocol(): AdapterProtocol {
  const protocol = boundedCompletionProtocol();
  return {
    ...protocol,
    id: 'github-pr-update-branch-unbounded-pending',
    transitions: [
      ...protocol.transitions,
      { from: 'q', to: 'q', event: 'provider-still-pending' },
    ],
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
  };
}

const bounded = analyzeAdapterProtocol(boundedCompletionProtocol());
const unbounded = analyzeAdapterProtocol(unboundedPendingProtocol());

assert.equal(bounded.diagnosable, true);
assert.equal(bounded.safeDiagnosable, false);
assert.equal(bounded.unsafeWitness?.action, 'release-authority');
assert.equal(releaseDecision(bounded), 'ambiguous-do-not-release');
assert.equal(boundedAmbiguousObservationSequences(boundedCompletionProtocol(), 12), 0);

assert.equal(unbounded.diagnosable, false);
assert.equal(unbounded.safeDiagnosable, false);
assert.equal(unbounded.unsafeWitness?.action, 'release-authority');
assert.ok(unbounded.nonDiagnosableWitness?.length);
assert.equal(releaseDecision(unbounded), 'ambiguous-do-not-release');
assert.ok(boundedAmbiguousObservationSequences(unboundedPendingProtocol(), 12) > 0);

const capabilities = effectAdapterCapabilities(GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT);
assert.ok(capabilities);
assert.equal(capabilities.replay.kind, 'forbidden');
assert.equal(capabilities.reservation_release.kind, 'forbidden');

const p = postcondition();
const unchanged = observePostcondition(p, {
  githubToken: 'token',
  githubGet: (_token, path) => {
    if (path === '/repos/acme/widget') return repository();
    if (path === '/repos/acme/widget/pulls/37') return pull();
    throw new Error('unexpected provider path: ' + path);
  },
});
assert.equal(unchanged.mutation_certainty, 'absent');
assert.equal(authoritativeAbsenceEvidence(p, unchanged), null);
assert.equal(observationVerified(p, unchanged), false);

const completed = observePostcondition(p, {
  githubToken: 'token',
  githubGet: (_token, path) => {
    if (path === '/repos/acme/widget') return repository();
    if (path === '/repos/acme/widget/pulls/37') return pull(NEXT);
    if (path === `/repos/acme/widget/compare/${HEAD}...${NEXT}`) return compare(HEAD, NEXT);
    if (path === `/repos/acme/widget/compare/${BASE}...${NEXT}`) return compare(BASE, NEXT);
    throw new Error('unexpected provider path: ' + path);
  },
});
assert.equal(completed.mutation_certainty, 'present');
assert.equal(observationVerified(p, completed), true);

console.log(
  JSON.stringify(
    {
      experiment: 'async-effect-diagnosability',
      boundedCompletion: {
        diagnosable: bounded.diagnosable,
        safeDiagnosable: bounded.safeDiagnosable,
        ambiguousPairs: bounded.ambiguousPairs,
        maxAmbiguousObservableDelay: bounded.maxAmbiguousObservableDelay,
        depth12AmbiguousSequences: boundedAmbiguousObservationSequences(
          boundedCompletionProtocol(),
          12,
        ),
        unsafeAction: bounded.unsafeWitness?.action ?? null,
        decision: releaseDecision(bounded),
      },
      unboundedPending: {
        diagnosable: unbounded.diagnosable,
        safeDiagnosable: unbounded.safeDiagnosable,
        ambiguousPairs: unbounded.ambiguousPairs,
        maxAmbiguousObservableDelay: unbounded.maxAmbiguousObservableDelay,
        depth12AmbiguousSequences: boundedAmbiguousObservationSequences(
          unboundedPendingProtocol(),
          12,
        ),
        unsafeAction: unbounded.unsafeWitness?.action ?? null,
        witnessLength: unbounded.nonDiagnosableWitness?.length ?? 0,
        decision: releaseDecision(unbounded),
      },
      productionCrossCheck: {
        replay: capabilities.replay.kind,
        reservationRelease: capabilities.reservation_release.kind,
        unchangedReadback: unchanged.mutation_certainty,
        unchangedAuthoritativeAbsence: authoritativeAbsenceEvidence(p, unchanged) !== null,
        completedReadbackVerified: observationVerified(p, completed),
      },
    },
    null,
    2,
  ),
);
