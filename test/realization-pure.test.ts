import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDigest, sha256 } from '../src/digest.ts';
import {
  externalEffectIdentity,
  realizationObligationKey,
  reusableRealization,
  verifyRealizationCandidate,
  type RealizationContract,
} from '../src/realization.ts';

const OUTPUT='compiled artifact bytes';

function contract(overrides:Partial<RealizationContract>={}):RealizationContract {
  return {
    packet:{command:'build',target:'app'},
    semantic_dependencies:[
      {selector:'source-tree',identity:'git-tree:aaa'},
      {selector:'toolchain',identity:'node:22.16.0'},
    ],
    verifier_identity:'artifact-sha256/v1',
    material_configuration:{os:'linux',arch:'x64',mode:'release'},
    source_inputs:{commit:'1111111111111111111111111111111111111111'},
    acceptance_predicate:{
      kind:'sha256-equals/v1',
      expected_sha256:sha256(OUTPUT),
    },
    reuse_mode:'content-addressed',
    ...overrides,
  };
}

test('agent, human, and previous run produce the same exact verified realization evidence',()=>{
  const current=contract();
  const producers=[
    {kind:'agent',id:'agent-a'} as const,
    {kind:'human',id:'laura'} as const,
    {kind:'previous-run',id:'run-17'} as const,
  ];
  const facts=producers.map(producer=>verifyRealizationCandidate(current,{producer,content:OUTPUT}));

  assert.deepEqual(facts[0],facts[1]);
  assert.deepEqual(facts[1],facts[2]);
  const decision=reusableRealization(current,[facts[0]]);
  assert.equal(decision.satisfied,true);
  assert.equal(decision.reason,'REUSED_VERIFIED_REALIZATION');
});

test('semantic dependency order is not material, but dependency identity is',()=>{
  const original=contract();
  const fact=verifyRealizationCandidate(original,{
    producer:{kind:'agent',id:'agent-a'},
    content:OUTPUT,
  });
  const reordered=contract({semantic_dependencies:[...original.semantic_dependencies].reverse()});
  assert.equal(realizationObligationKey(reordered),realizationObligationKey(original));
  assert.equal(reusableRealization(reordered,[fact]).satisfied,true);

  const changed=contract({
    semantic_dependencies:[
      {selector:'source-tree',identity:'git-tree:bbb'},
      {selector:'toolchain',identity:'node:22.16.0'},
    ],
  });
  assert.notEqual(realizationObligationKey(changed),realizationObligationKey(original));
  assert.deepEqual(reusableRealization(changed,[fact]),{
    satisfied:false,
    reason:'NO_MATCHING_REALIZATION',
    obligation_key:realizationObligationKey(changed),
  });
});

test('every material semantic change invalidates reuse',()=>{
  const original=contract();
  const fact=verifyRealizationCandidate(original,{
    producer:{kind:'previous-run',id:'run-17'},
    content:OUTPUT,
  });

  const hostileChanges:RealizationContract[]=[
    contract({verifier_identity:'artifact-sha256/v2'}),
    contract({material_configuration:{os:'linux',arch:'arm64',mode:'release'}}),
    contract({source_inputs:{commit:'2222222222222222222222222222222222222222'}}),
    contract({acceptance_predicate:{
      kind:'sha256-equals/v1',
      expected_sha256:sha256(OUTPUT),
      policy_revision:'2',
    }}),
    contract({packet:{command:'build',target:'different-app'}}),
  ];

  for (const changed of hostileChanges) {
    assert.notEqual(realizationObligationKey(changed),realizationObligationKey(original));
    assert.equal(reusableRealization(changed,[fact]).satisfied,false);
  }
});

test('external effects cannot become historical cache hits even with a hostile matching fact',()=>{
  const external=contract({reuse_mode:'external-effect'});
  const key=realizationObligationKey(external);
  const hostile={
    schema:'overcenter-verified-realization-v1' as const,
    obligation_key:key,
    realization_identity:`sha256:${sha256(OUTPUT)}`,
    evidence:{
      verifier_identity:external.verifier_identity,
      acceptance_predicate_digest:canonicalDigest(external.acceptance_predicate),
      output_sha256:sha256(OUTPUT),
    },
  };

  assert.throws(
    ()=>verifyRealizationCandidate(external,{
      producer:{kind:'agent',id:'agent-a'},
      content:OUTPUT,
    }),
    /EXTERNAL_EFFECT_NOT_REUSABLE/,
  );
  assert.deepEqual(reusableRealization(external,[hostile]),{
    satisfied:false,
    reason:'CURRENT_OBSERVATION_REQUIRED',
    obligation_key:key,
  });
});

test('external effect identity binds semantic obligation and exact run',()=>{
  const a=contract({reuse_mode:'external-effect'});
  const b=contract({
    reuse_mode:'external-effect',
    source_inputs:{commit:'2222222222222222222222222222222222222222'},
  });

  assert.equal(externalEffectIdentity(a,'run-a'),externalEffectIdentity(a,'run-a'));
  assert.notEqual(externalEffectIdentity(a,'run-a'),externalEffectIdentity(a,'run-b'));
  assert.notEqual(externalEffectIdentity(a,'run-a'),externalEffectIdentity(b,'run-a'));
  assert.throws(
    ()=>externalEffectIdentity(contract(),'run-a'),
    /EXTERNAL_EFFECT_IDENTITY_REQUIRES_EXTERNAL_EFFECT/,
  );
});
