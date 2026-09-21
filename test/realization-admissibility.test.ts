import assert from 'node:assert/strict';
import test from 'node:test';

import { localFileEnoentEvidence } from '../src/evidence.ts';
import type {
  HistoricalRun,
  Receipt,
  State,
} from '../src/facts.ts';
import type { Obligation } from '../src/model.ts';
import {
  classifyCurrentRealization,
  deriveCurrentRealizationJudgments,
} from '../src/realization-admissibility.ts';

const work:Obligation={
  id:'a',
  dependencies:[],
  packet:{},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:'/provider/a',
    content:'A',
  },
};
const state:State={
  obligations:{a:work},
  definition_ids:{a:'define-a'},
};

test('current realization classifier separates proof, contradiction, absence, and uncertainty',()=>{
  const expected='559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd';

  assert.deepEqual(
    classifyCurrentRealization(work.postcondition,{
      verifier:'file-content-equals/v1',
      path:'/provider/a',
      expected_sha256:expected,
      actual_sha256:expected,
      mutation_certainty:'present',
    }),
    {
      state:'admissible',
      reason:'CURRENT_POSTCONDITION_VERIFIED',
    },
  );

  assert.deepEqual(
    classifyCurrentRealization(work.postcondition,{
      verifier:'file-content-equals/v1',
      path:'/provider/a',
      expected_sha256:expected,
      actual_sha256:'0'.repeat(64),
      mutation_certainty:'present',
    }),
    {
      state:'rejected',
      reason:'CURRENT_POSTCONDITION_NOT_VERIFIED',
    },
  );

  assert.deepEqual(
    classifyCurrentRealization(work.postcondition,{
      verifier:'file-content-equals/v1',
      path:'/provider/a',
      expected_sha256:expected,
      mutation_certainty:'absent',
      absence_evidence:localFileEnoentEvidence('/provider/a'),
    }),
    {
      state:'rejected',
      reason:'CURRENT_REALIZATION_AUTHORITATIVELY_ABSENT',
    },
  );

  assert.deepEqual(
    classifyCurrentRealization(work.postcondition,{
      verifier:'file-content-equals/v1',
      path:'/provider/a',
      expected_sha256:expected,
      mutation_certainty:'uncertain',
      observation_error:'READBACK_UNAVAILABLE',
    }),
    {
      state:'indeterminate',
      reason:'READBACK_UNAVAILABLE',
    },
  );

  assert.deepEqual(
    classifyCurrentRealization(work.postcondition,{
      verifier:'file-content-equals/v1',
      path:'/wrong-coordinate',
      expected_sha256:expected,
      actual_sha256:expected,
      mutation_certainty:'present',
    }),
    {
      state:'indeterminate',
      reason:'OBSERVATION_COORDINATE_MISMATCH',
    },
  );
});

test('current judgment derivation observes only exact-key historical DONE obligations once',()=>{
  const run:HistoricalRun={
    id:'run-a',
    obligation_id:'a',
    claimed_revision:'revision-a',
    claim_commit:'claim-a',
    obligation_key:'key-a',
    execution_generation:1,
    execution_authority_commit:'claim-a',
    execution_capability_sha256:'0'.repeat(64),
    obligation:work,
    definition_commit:'define-a',
  };
  const receipt:Receipt={
    schema:'overcenter-git-receipt-v5',
    run_id:'run-a',
    obligation_id:'a',
    claimed_revision:'revision-a',
    claim_commit:'claim-a',
    execution_generation:1,
    execution_authority_commit:'claim-a',
    kind:'observation',
    observed:null,
    settled_at:'now',
    disposition:'DONE',
    verified:true,
    settlement_commit:'receipt-a',
  };
  let observations=0;
  const judgments=deriveCurrentRealizationJudgments({
    state,
    runs:new Map([[run.id,run]]),
    receiptsByRun:new Map([[run.id,receipt]]),
    semanticKeys:new Map([['a','key-a']]),
    observe:postcondition=>{
      observations+=1;
      assert.deepEqual(postcondition,work.postcondition);
      return {
        verifier:'file-content-equals/v1',
        path:'/provider/a',
        expected_sha256:'559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
        actual_sha256:'559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
        mutation_certainty:'present',
      };
    },
  });

  assert.equal(observations,1);
  assert.deepEqual(judgments.get('run-a'),{
    state:'admissible',
    reason:'CURRENT_POSTCONDITION_VERIFIED',
  });

  observations=0;
  const changed=deriveCurrentRealizationJudgments({
    state,
    runs:new Map([[run.id,run]]),
    receiptsByRun:new Map([[run.id,receipt]]),
    semanticKeys:new Map([['a','different-key']]),
    observe:()=>{
      observations+=1;
      throw new Error('should not observe stale semantic identity');
    },
  });
  assert.equal(observations,0);
  assert.equal(changed.size,0);
});
