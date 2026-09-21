import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_EMITTER,
  EVIDENCE_RECONCILER,
  EVIDENCE_RECONCILER_TEST,
  MUTATION_PROBES,
  MUTATION_SELECTOR,
  MUTATION_SELECTOR_TEST,
  MUTATION_WORKFLOW,
  changedMutationProbeIds,
  selectMutationProbe,
} from './select-mutation-probe.mjs';

const select=(changed,eventName='pull_request',options={})=>
  selectMutationProbe({eventName,changed,...options});

test('manual dispatch runs the broad probe',()=>{
  assert.deepEqual(select([], 'workflow_dispatch'),{
    runProbe:true,
    mutationProbe:'',
  });
});

test('unrelated source and prose changes skip mutation execution',()=>{
  assert.deepEqual(select(['README.md','src/unranked-helper.ts']),{
    runProbe:false,
    mutationProbe:'',
  });
});

test('configured source files derive their probe selection from the config',()=>{
  assert.deepEqual(select(['src/digest.ts']),{
    runProbe:true,
    mutationProbe:'digest-foundation',
  });
  assert.deepEqual(select(['src/projector.ts']),{
    runProbe:true,
    mutationProbe:'done-candidate-reuse',
  });
  assert.deepEqual(select(['src/kernel-core.ts']),{
    runProbe:true,
    mutationProbe:'effect-reservation,settlement',
  });
  assert.deepEqual(select(['src/transaction-admission.ts']),{
    runProbe:true,
    mutationProbe:'execution-fence',
  });
});

test('targeted hostile tests select their owned semantic region',()=>{
  assert.deepEqual(select([
    'src/semantic-identity.ts',
    'test/semantic-identity-hostile.test.ts',
  ]),{
    runProbe:true,
    mutationProbe:'semantic-identity',
  });
  assert.deepEqual(select([
    'src/observation.ts',
    'test/observation-hostile.test.ts',
  ]),{
    runProbe:true,
    mutationProbe:'verification-and-absence',
  });
});

test('independent targeted regions compose in config order',()=>{
  assert.deepEqual(select([
    'src/observation.ts',
    'src/semantic-identity.ts',
  ]),{
    runProbe:true,
    mutationProbe:'semantic-identity,verification-and-absence',
  });
});

test('probe config diff identifies only changed current probe ids',()=>{
  const base={probes:[
    {id:'a',selectors:[{file:'src/a.ts',name:'old'}]},
    {id:'b',selectors:[{file:'src/b.ts',name:'same'}]},
  ]};
  const head={probes:[
    {id:'a',selectors:[{file:'src/a.ts',name:'new'}]},
    {id:'b',selectors:[{file:'src/b.ts',name:'same'}]},
    {id:'c',selectors:[{file:'src/c.ts',name:'new'}]},
  ]};
  assert.deepEqual(changedMutationProbeIds(base,head),['a','c']);
  assert.throws(
    ()=>changedMutationProbeIds(head,{probes:head.probes.slice(0,2)}),
    /explicit evidence retirement: c/,
  );
});

test('explicit probe-config changes run only the changed probes',()=>{
  assert.deepEqual(select([MUTATION_PROBES],'pull_request',{
    changedProbeIds:['settlement'],
  }),{
    runProbe:true,
    mutationProbe:'settlement',
  });
  assert.deepEqual(select([MUTATION_PROBES]),{
    runProbe:true,
    mutationProbe:'',
  });
});

test('mutation-engine mechanics still force the broad probe',()=>{
  for(const file of [
    'experiments/production-criticality-ranking/resolve-mutation-probes.mjs',
    'experiments/production-criticality-ranking/stryker.config.mjs',
    'experiments/production-criticality-ranking/summarize-mutation.mjs',
    'experiments/production-criticality-ranking/summarize-mutation.test.mjs',
  ]){
    assert.deepEqual(select([file]),{
      runProbe:true,
      mutationProbe:'',
    },file);
  }
});

test('generic hostile regressions still force the broad probe',()=>{
  assert.deepEqual(select(['test/hostile.test.ts']),{
    runProbe:true,
    mutationProbe:'',
  });
  assert.deepEqual(select(['test/some-other-hostile.test.ts']),{
    runProbe:true,
    mutationProbe:'',
  });
});

test('workflow and evidence plumbing use one end-to-end smoke probe',()=>{
  for(const changed of [
    [MUTATION_WORKFLOW],
    [MUTATION_SELECTOR],
    [MUTATION_SELECTOR_TEST],
    [EVIDENCE_EMITTER],
    [EVIDENCE_RECONCILER],
    [EVIDENCE_RECONCILER_TEST],
    [
      MUTATION_WORKFLOW,
      MUTATION_SELECTOR,
      MUTATION_SELECTOR_TEST,
      EVIDENCE_EMITTER,
      EVIDENCE_RECONCILER,
      EVIDENCE_RECONCILER_TEST,
    ],
  ]){
    assert.deepEqual(select(changed),{
      runProbe:true,
      mutationProbe:'semantic-identity',
    });
  }
});

test('configured source changes take precedence over plumbing smoke selection',()=>{
  assert.deepEqual(select([
    MUTATION_WORKFLOW,
    'src/observation.ts',
  ]),{
    runProbe:true,
    mutationProbe:'verification-and-absence',
  });
  assert.deepEqual(select([
    MUTATION_SELECTOR,
    'src/kernel-core.ts',
  ]),{
    runProbe:true,
    mutationProbe:'effect-reservation,settlement',
  });
});

test('evidence-verifier-only changes leave mutation execution skipped',()=>{
  assert.deepEqual(select([
    'experiments/production-criticality-ranking/verify-mutation-evidence.mjs',
    'experiments/production-criticality-ranking/mutation-evidence.json',
  ]),{
    runProbe:false,
    mutationProbe:'',
  });
});
