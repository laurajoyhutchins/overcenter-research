import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeObligation,
  obligationDefinition,
  obligationDefinitionId,
  type State,
} from '../src/authority/facts.ts';
import {
  compileTcbObligations,
  tcbObligationsGraphProducer,
  TCB_OBLIGATION_PREFIX,
  TCB_OBLIGATIONS_PATH,
} from '../src/authority/tcb-obligations.ts';
import { deriveProjectProjection } from '../src/authority/project-state.ts';
import { observePostcondition } from '../src/observation/observe.ts';
import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../src/effect-adapter.ts';

const manifest = {
  schema: 'overcenter-tcb-obligations/v1',
  obligations: [
    {
      id: 'tcb:hostile-evidence-stale:no-false-done:settlement',
      kind: 'hostile-evidence-stale',
      scope: 'no-false-done',
      task: {
        schema: 'overcenter-source-task/v1',
        kind: 'source-change',
        objective: 'Refresh hostile settlement evidence.',
        writable_paths: [
          'experiments/production-criticality-ranking/mutation-evidence.json',
          'src/authority/replay.ts',
        ],
      },
      evidence: {
        probe_id: 'settlement',
        mutation_score: 1,
      },
    },
  ],
} as const;

test('executable TCB findings compile into bounded source-change obligations', () => {
  assert.deepEqual(tcbObligationsGraphProducer.input_paths, [TCB_OBLIGATIONS_PATH]);
  assert.deepEqual(tcbObligationsGraphProducer.managed_prefixes, [TCB_OBLIGATION_PREFIX]);
  const [compiled] = compileTcbObligations(manifest);
  assert.ok(compiled);
  const obligation = normalizeObligation(compiled);
  assert.equal(obligation.id.startsWith(TCB_OBLIGATION_PREFIX), true);
  assert.deepEqual(obligation.packet, {
    ...manifest.obligations[0].task,
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
    acceptance: {
      verifier: 'tcb-finding-absent/v1',
      finding_id: manifest.obligations[0].id,
    },
    context: {
      schema: 'overcenter-tcb-finding/v1',
      finding_kind: manifest.obligations[0].kind,
      scope: manifest.obligations[0].scope,
      evidence: manifest.obligations[0].evidence,
    },
  });
  assert.deepEqual(obligation.postcondition, { verifier: 'source-integration/v1' });

  const definition = obligationDefinition(obligation);
  const state: State = {
    obligations: { [obligation.id]: obligation },
    definition_ids: { [obligation.id]: obligationDefinitionId(definition) },
  };
  const project = deriveProjectProjection({
    state,
    runs: new Map(),
    receiptsByRun: new Map(),
    revision: 'authority-head',
  });

  assert.equal(project.readyWork?.id, obligation.id);
  assert.equal(project.work[0]?.status, 'READY');
  const explanation = project.explanations.get(obligation.id);
  assert.equal(explanation?.status, 'READY');
  assert.equal(explanation?.reason.kind, 'claimable');
});

test('non-executable TCB findings retain the operator-judgment boundary', () => {
  const [compiled] = compileTcbObligations({
    ...manifest,
    obligations: [
      {
        ...manifest.obligations[0],
        id: 'tcb:hostile-evidence-missing:no-false-done:settlement',
        kind: 'hostile-evidence-missing',
      },
    ],
  });
  assert.ok(compiled);
  const obligation = normalizeObligation(compiled);
  assert.equal(obligation.packet.kind, 'judgment-required');
  assert.equal(obligation.postcondition.verifier, 'operator-judgment/v1');
});

test('TCB obligation compiler fails closed on unmanaged identities and finding kinds', () => {
  assert.throws(
    () =>
      compileTcbObligations({
        ...manifest,
        obligations: [{ ...manifest.obligations[0], id: 'ordinary-work' }],
      }),
    /TCB_OBLIGATION_ID_NAMESPACE_INVALID/,
  );
  assert.throws(
    () =>
      compileTcbObligations({
        ...manifest,
        obligations: [{ ...manifest.obligations[0], kind: 'invented' }],
      }),
    /TCB_OBLIGATION_KIND_INVALID/,
  );
});

test('operator judgment postconditions cannot be settled by automatic observation', () => {
  assert.throws(
    () =>
      observePostcondition(
        {
          verifier: 'operator-judgment/v1',
          subject: { kind: 'tcb-remediation', finding_id: manifest.obligations[0].id },
        },
        { githubToken: null },
      ),
    /OPERATOR_JUDGMENT_NOT_AUTOMATICALLY_OBSERVABLE/,
  );
});
