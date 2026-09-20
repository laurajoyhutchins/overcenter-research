import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MUTATION_SELECTOR,
  MUTATION_SELECTOR_TEST,
  MUTATION_WORKFLOW,
  selectMutationProbe,
} from './select-mutation-probe.mjs';

const select=(changed,eventName='pull_request')=>
  selectMutationProbe({eventName,changed});

test('manual dispatch runs the broad probe',()=>{
  assert.deepEqual(select([], 'workflow_dispatch'),{
    runProbe:true,
    mutationProbe:'',
  });
});

test('unrelated changes skip mutation execution',()=>{
  assert.deepEqual(select(['README.md']),{
    runProbe:false,
    mutationProbe:'',
  });
});

test('semantic identity changes select only semantic identity',()=>{
  assert.deepEqual(select([
    'src/semantic-identity.ts',
    'test/semantic-identity-hostile.test.ts',
  ]),{
    runProbe:true,
    mutationProbe:'semantic-identity',
  });
});

test('observation changes select only verification and absence',()=>{
  assert.deepEqual(select([
    'src/observation.ts',
    'test/observation-hostile.test.ts',
  ]),{
    runProbe:true,
    mutationProbe:'verification-and-absence',
  });
});

test('Deployment realization changes select only the focused verifier probe',()=>{
  assert.deepEqual(select([
    'src/providers/kubernetes-deployment.ts',
    'test/kubernetes-deployment-verifier.test.ts',
  ]),{
    runProbe:true,
    mutationProbe:'kubernetes-deployment-realization',
  });
});

test('independent targeted regions compose deterministically',()=>{
  assert.deepEqual(select([
    'src/observation.ts',
    'src/semantic-identity.ts',
  ]),{
    runProbe:true,
    mutationProbe:'semantic-identity,verification-and-absence',
  });
});

test('production foundations and mutation-engine config force the broad probe',()=>{
  for (const file of [
    'src/digest.ts',
    'src/projector.ts',
    'src/kernel-core.ts',
    'experiments/production-criticality-ranking/mutation-probes.json',
    'experiments/production-criticality-ranking/resolve-mutation-probes.mjs',
    'experiments/production-criticality-ranking/stryker.config.mjs',
    'experiments/production-criticality-ranking/summarize-mutation.mjs',
    'experiments/production-criticality-ranking/summarize-mutation.test.mjs',
    'experiments/production-criticality-ranking/emit-mutation-evidence.mjs',
  ]) {
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

test('workflow and selector plumbing use one end-to-end smoke probe',()=>{
  for (const changed of [
    [MUTATION_WORKFLOW],
    [MUTATION_SELECTOR],
    [MUTATION_SELECTOR_TEST],
    [MUTATION_WORKFLOW,MUTATION_SELECTOR,MUTATION_SELECTOR_TEST],
  ]) {
    assert.deepEqual(select(changed),{
      runProbe:true,
      mutationProbe:'semantic-identity',
    });
  }
});

test('semantic changes take precedence over plumbing smoke selection',()=>{
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
    mutationProbe:'',
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
