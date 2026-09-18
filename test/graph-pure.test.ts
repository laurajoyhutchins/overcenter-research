import assert from 'node:assert/strict';
import test from 'node:test';
import type { Obligation } from '../src/model.ts';
import type { State } from '../src/facts.ts';
import {
  dependencyUpstreams,
  dependsOn,
  validateGraph,
  withObligation,
} from '../src/graph.ts';

const obligation=(id:string,dependencies:Obligation['dependencies']=[]):Obligation=>({
  id,
  dependencies,
  packet:{},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:`/tmp/${id}`,
    content:id,
  },
});

test('static graph validation accepts an acyclic dependency chain',()=>{
  let state:State={obligations:{},definition_commits:{}};
  state=withObligation(state,obligation('a'),'a-def');
  state=withObligation(
    state,
    obligation('b',[{kind:'control',upstream:'a'}]),
    'b-def',
  );
  state=withObligation(
    state,
    obligation('c',[{kind:'semantic',upstream:'b',consumes:{kind:'output',selector:'verified-content'}}]),
    'c-def',
  );

  validateGraph(state);
  assert.deepEqual(dependencyUpstreams(state.obligations.c),['b']);
  assert.equal(dependsOn(state,'c','a'),true);
  assert.equal(dependsOn(state,'a','c'),false);
});

test('static graph validation rejects unknown dependencies and cycles',()=>{
  const unknown:State={
    obligations:{
      a:obligation('a',[{kind:'control',upstream:'missing'}]),
    },
    definition_commits:{a:'a-def'},
  };
  assert.throws(()=>validateGraph(unknown),/UNKNOWN_DEPENDENCY:a:missing/);

  const cycle:State={
    obligations:{
      a:obligation('a',[{kind:'control',upstream:'b'}]),
      b:obligation('b',[{kind:'control',upstream:'a'}]),
    },
    definition_commits:{a:'a-def',b:'b-def'},
  };
  assert.throws(()=>validateGraph(cycle),/DEPENDENCY_CYCLE/);
});

test('static graph validation rejects unsupported semantic selectors before realization',()=>{
  const state:State={
    obligations:{
      a:obligation('a'),
      b:obligation('b',[{
        kind:'semantic',
        upstream:'a',
        consumes:{kind:'output',selector:'ambient-file'},
      }]),
    },
    definition_commits:{a:'a-def',b:'b-def'},
  };

  assert.throws(
    ()=>validateGraph(state),
    /UNSUPPORTED_SEMANTIC_SELECTOR:output:ambient-file/,
  );
});

test('static graph validation rejects unordered incompatible effects at admission',()=>{
  const status=(id:string,state:'success'|'failure'):Obligation=>({
    id,
    dependencies:[],
    packet:{},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/admission',
      expected_state:state,
    },
  });
  const state:State={
    obligations:{
      alpha:status('alpha','success'),
      beta:status('beta','failure'),
    },
    definition_commits:{alpha:'alpha-def',beta:'beta-def'},
  };

  assert.throws(
    ()=>validateGraph(state),
    /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
  );
});

test('static graph validation accepts an explicit ordering for incompatible effects',()=>{
  const alpha:Obligation={
    id:'alpha',
    dependencies:[],
    packet:{},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/admission',
      expected_state:'success',
    },
  };
  const beta:Obligation={
    id:'beta',
    dependencies:[{kind:'control',upstream:'alpha'}],
    packet:{},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/admission',
      expected_state:'failure',
    },
  };
  const state:State={
    obligations:{alpha,beta},
    definition_commits:{alpha:'alpha-def',beta:'beta-def'},
  };

  assert.doesNotThrow(()=>validateGraph(state));
});
