import assert from 'node:assert/strict';
import test from 'node:test';
import type { Obligation } from '../src/model.ts';
import type { State } from '../src/authority/facts.ts';
import {
  dependencyUpstreams,
  dependsOn,
  validateGraph,
  withObligation,
} from '../src/graph/topology.ts';

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
