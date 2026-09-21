import assert from 'node:assert/strict';
import test from 'node:test';
import type { Obligation } from '../src/model.ts';
import type { State } from '../src/facts.ts';
import {
  buildGraphIndex,
  dependencyUpstreams,
  dependsOn,
  graphDependsOn,
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


test('graph index handles a 10,000-node dependency chain without recursion',()=>{
  const count=10_000;
  const obligations:State['obligations']={};
  const definition_commits:State['definition_commits']={};
  for (let index=0;index<count;index+=1) {
    const id='deep-'+String(index).padStart(5,'0');
    obligations[id]=obligation(
      id,
      index===0
        ? []
        : [{
            kind:'control',
            upstream:'deep-'+String(index-1).padStart(5,'0'),
          }],
    );
    definition_commits[id]=id+'-def';
  }

  const graph=buildGraphIndex({obligations,definition_commits});
  assert.equal(graph.topologicalOrder.length,count);
  assert.equal(graph.topologicalOrder[0],'deep-00000');
  assert.equal(graph.topologicalOrder.at(-1),'deep-09999');
  assert.equal(
    graphDependsOn(graph,'deep-09999','deep-00000'),
    true,
  );
});
