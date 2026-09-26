import assert from 'node:assert/strict';
import test from 'node:test';

import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../src/effect-adapter.ts';
import {
  classifyJudgmentFrontier,
  type JudgmentFrontierDecision,
} from '../src/authority/judgment-frontier.ts';
import type { Work } from '../src/model.ts';
import type { ProjectExplanation } from '../src/authority/project-state.ts';

function sourceWork(id = 'tcb:hostile-evidence-stale:fixture'): Work {
  return {
    id,
    dependencies: [],
    packet: {
      schema: 'overcenter-source-task/v1',
      kind: 'source-change',
      objective: 'Refresh exact hostile evidence.',
      writable_paths: ['experiments/production-criticality-ranking/mutation-evidence.json'],
      effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
      acceptance: {
        verifier: 'tcb-finding-absent/v1',
        finding_id: id,
      },
      context: {
        schema: 'overcenter-tcb-finding/v1',
        finding_kind: 'hostile-evidence-stale',
        scope: 'fixture',
        evidence: {
          probe_id: 'fixture-probe',
          stale_sources: [
            {
              path: 'src/authority/engine.ts',
              expected_blob_sha1: 'a'.repeat(40),
              current_blob_sha1: 'b'.repeat(40),
              current: false,
            },
          ],
        },
      },
    },
    postcondition: { verifier: 'source-integration/v1' },
    status: 'READY',
    revision: 'authority-head',
  };
}

function readyExplanation(id: string, stale = false): ProjectExplanation {
  return {
    obligation_id: id,
    status: 'READY',
    reason: {
      kind: 'claimable',
      semantic_key: 'semantic-key',
      dependencies: [],
      ...(stale
        ? {
            rejected_realization: {
              run_id: 'prior-run',
              disposition: 'DONE',
              reason: 'not-currently-admissible',
            },
          }
        : {}),
    },
  };
}

function classify(
  work: Work,
  explanation: ProjectExplanation,
  unresolvedEffect = false,
): JudgmentFrontierDecision {
  return classifyJudgmentFrontier({
    work,
    explanation,
    unresolved_effect: unresolvedEffect,
  });
}

test('derivable hostile-evidence debt stays in deterministic software', () => {
  const work = sourceWork();
  const first = classify(work, readyExplanation(work.id));
  const second = classify(structuredClone(work), readyExplanation(work.id));

  assert.deepEqual(first, second);
  assert.equal(first.route, 'deterministic-software-action');
  assert.equal(first.reason_code, 'DERIVABLE_HOSTILE_EVIDENCE_DEBT');
  assert.deepEqual(first.evidence_predicates, [
    'work.status=READY',
    'packet.kind=source-change',
    'packet.context.finding_kind=hostile-evidence-stale',
    'packet.writable_paths includes experiments/production-criticality-ranking/mutation-evidence.json',
    'packet.context.evidence.stale_sources=exact-nonempty-current-false',
    `packet.effect_contract=${GITHUB_SOURCE_INTEGRATION_EFFECT}`,
    `packet.acceptance.finding_id=${work.id}`,
  ]);
});

test('hostile-evidence label without exact stale blobs cannot acquire software routing', () => {
  const work = sourceWork();
  work.packet.context = {
    schema: 'overcenter-tcb-finding/v1',
    finding_kind: 'hostile-evidence-stale',
    scope: 'fixture',
    evidence: {
      probe_id: 'fixture-probe',
      stale_sources: [],
    },
  };

  const result = classify(work, readyExplanation(work.id));
  assert.equal(result.route, 'reasoning-required');
  assert.equal(result.reason_code, 'OPEN_ENDED_SOURCE_REMEDIATION');
});

test('open-ended source remediation remains on the reasoning frontier', () => {
  const work = sourceWork('source:open-ended');
  delete work.packet.acceptance;
  delete work.packet.context;

  const result = classify(work, readyExplanation(work.id));
  assert.equal(result.route, 'reasoning-required');
  assert.equal(result.reason_code, 'OPEN_ENDED_SOURCE_REMEDIATION');
  assert.ok(result.evidence_predicates.includes('packet.kind=source-change'));
});

test('unresolved mutation reservation dominates an apparently READY work item', () => {
  const work = sourceWork('source:ambiguous');
  const result = classify(work, readyExplanation(work.id), true);

  assert.equal(result.route, 'recovery-required');
  assert.equal(result.reason_code, 'AMBIGUOUS_RESERVED_MUTATION');
  assert.ok(result.evidence_predicates.includes('effect_reservation=unresolved'));
  assert.equal(
    result.evidence_predicates.some((predicate) => predicate.includes('reasoning')),
    false,
  );
});

test('stale exact-revision system evidence routes to deterministic refresh', () => {
  const work: Work = {
    id: 'system-evidence:fixture',
    dependencies: [],
    packet: {
      schema: 'overcenter-system-evidence/v1',
      kind: 'system-evidence',
      evidence_kind: 'fixture',
    },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/tmp/overcenter-frontier-evidence',
      content: 'current\n',
    },
    status: 'READY',
    revision: 'authority-head',
  };

  const result = classify(work, readyExplanation(work.id, true));
  assert.equal(result.route, 'deterministic-software-action');
  assert.equal(result.reason_code, 'STALE_EXACT_REVISION_EVIDENCE');
  assert.ok(result.evidence_predicates.includes('prior_realization=currently-rejected'));
});

test('already-satisfied postcondition needs no reasoning authority', () => {
  const work = sourceWork('source:done');
  work.status = 'DONE';
  work.run_id = 'done-run';
  const explanation: ProjectExplanation = {
    obligation_id: work.id,
    status: 'DONE',
    reason: {
      kind: 'admissible-realization',
      run_id: 'done-run',
      semantic_key: 'semantic-key',
      admissibility_basis: 'current-semantic-judgment',
    },
  };

  const result = classify(work, explanation);
  assert.equal(result.route, 'deterministic-software-action');
  assert.equal(result.reason_code, 'POSTCONDITION_ALREADY_SATISFIED');
});

test('declared operator judgment and unsupported packets remain fail-closed', () => {
  const judgment: Work = {
    id: 'judgment',
    dependencies: [],
    packet: { kind: 'judgment-required' },
    postcondition: {
      verifier: 'operator-judgment/v1',
      subject: { question: 'choose' },
    },
    status: 'BLOCKED',
    revision: 'authority-head',
    blocked_reason: 'JUDGMENT_REQUIRED',
  };
  const judgmentResult = classify(judgment, {
    obligation_id: judgment.id,
    status: 'BLOCKED',
    reason: {
      kind: 'judgment-required',
      subject: { question: 'choose' },
    },
  });
  assert.equal(judgmentResult.route, 'reasoning-required');
  assert.equal(judgmentResult.reason_code, 'DECLARED_JUDGMENT_REQUIRED');

  const unsupported: Work = {
    id: 'unsupported',
    dependencies: [],
    packet: { schema: 'provider-effect/v1', kind: 'provider-effect' },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: '/tmp/overcenter-frontier-unsupported',
      content: 'done\n',
    },
    status: 'READY',
    revision: 'authority-head',
  };
  const unsupportedResult = classify(unsupported, readyExplanation(unsupported.id));
  assert.equal(unsupportedResult.route, 'unsupported');
  assert.equal(unsupportedResult.reason_code, 'PACKET_UNSUPPORTED');
});
