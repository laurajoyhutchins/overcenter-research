import assert from 'node:assert/strict';
import test from 'node:test';
import type { Obligation } from '../src/model.ts';
import type { State } from '../src/facts.ts';
import {
  buildStaticEffectIndex,
  staticEffectConflict,
  validateAdmission,
} from '../src/admission.ts';
import { dependsOn } from '../src/graph.ts';
import { effectSemantics } from '../src/semantics.ts';

const fileObligation=(id:string,dependencies:Obligation['dependencies']=[]):Obligation=>({
  id,
  dependencies,
  packet:{},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:`/tmp/${id}`,
    content:id,
  },
});

const statusObligation=(
  id:string,
  state:'success'|'failure',
  dependencies:Obligation['dependencies']=[],
):Obligation=>({
  id,
  dependencies,
  packet:{},
  postcondition:{
    verifier:'github-commit-status/v2',
    provider:'github',
    repository_id:123,
    repository_full_name:'owner/repo',
    commit_sha:'a'.repeat(40),
    context:'overcenter/admission',
    expected_state:state,
  },
});

test('admission rejects unsupported semantic selectors before realization',()=>{
  const state:State={
    obligations:{
      a:fileObligation('a'),
      b:fileObligation('b',[{
        kind:'semantic',
        upstream:'a',
        consumes:{kind:'output',selector:'ambient-file'},
      }]),
    },
    definition_ids:{a:'a-def',b:'b-def'},
  };

  assert.throws(
    ()=>validateAdmission(state),
    /UNSUPPORTED_SEMANTIC_SELECTOR:output:ambient-file/,
  );
});

test('admission rejects unordered incompatible static effects',()=>{
  const state:State={
    obligations:{
      alpha:statusObligation('alpha','success'),
      beta:statusObligation('beta','failure'),
    },
    definition_ids:{alpha:'alpha-def',beta:'beta-def'},
  };

  assert.throws(
    ()=>validateAdmission(state),
    /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
  );
});

test('admission accepts explicit ordering for incompatible effects',()=>{
  const state:State={
    obligations:{
      alpha:statusObligation('alpha','success'),
      beta:statusObligation(
        'beta',
        'failure',
        [{kind:'control',upstream:'alpha'}],
      ),
    },
    definition_ids:{alpha:'alpha-def',beta:'beta-def'},
  };

  assert.doesNotThrow(()=>validateAdmission(state));
});


function referenceStaticEffectConflict(
  state:State,
  workId:string,
):string|null {
  const work=state.obligations[workId];
  if (!work) return null;
  const semantics=effectSemantics(work.postcondition);
  if (!semantics) return null;

  for (const other of Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))) {
    if (other.id===work.id) continue;
    const otherSemantics=effectSemantics(other.postcondition);
    if (!otherSemantics || otherSemantics.resource!==semantics.resource) continue;

    if (
      otherSemantics.desired===semantics.desired
      && semantics.sameDesiredCommutes
      && otherSemantics.sameDesiredCommutes
    ) continue;

    if (
      !dependsOn(state,work.id,other.id)
      && !dependsOn(state,other.id,work.id)
    ) {
      const [left,right]=[work.id,other.id].sort();
      return `UNORDERED_EFFECT_CONFLICT:${left}:${right}`;
    }
  }
  return null;
}

test('indexed effect ordering matches recursive reference on every four-node labeled DAG',()=>{
  const ids=['a','b','c','d'];
  const possibleEdges=[
    [1,0],[2,0],[2,1],[3,0],[3,1],[3,2],
  ] as const;

  for (let edgeMask=0;edgeMask<(1<<possibleEdges.length);edgeMask+=1) {
    for (let desiredMask=0;desiredMask<(1<<ids.length);desiredMask+=1) {
      const obligations:State['obligations']={};
      for (let index=0;index<ids.length;index+=1) {
        const dependencies=possibleEdges
          .filter((_,edgeIndex)=>(edgeMask&(1<<edgeIndex))!==0)
          .filter(([downstream])=>downstream===index)
          .map(([,upstream])=>({
            kind:'control' as const,
            upstream:ids[upstream],
          }));
        obligations[ids[index]]=statusObligation(
          ids[index],
          (desiredMask&(1<<index))!==0 ? 'success' : 'failure',
          dependencies,
        );
      }
      const state:State={
        obligations,
        definition_ids:Object.fromEntries(
          ids.map(id=>[id,`${id}-def`]),
        ),
      };
      const index=buildStaticEffectIndex(state);
      for (const id of ids) {
        assert.equal(
          staticEffectConflict(state,id,index)?.code??null,
          referenceStaticEffectConflict(state,id),
          `edgeMask=${edgeMask} desiredMask=${desiredMask} id=${id}`,
        );
      }
    }
  }
});


const prUpdateObligation=(
  id:string,
  previousHead:string,
  dependencies:Obligation['dependencies']=[],
):Obligation=>({
  id,
  dependencies,
  packet:{},
  postcondition:{
    verifier:'github-pull-request-branch-updated/v1',
    provider:'github',
    repository_id:123,
    repository_full_name:'owner/repo',
    pull_number:17,
    pull_node_id:'PR_node_17',
    expected_previous_head_sha:previousHead,
    base_ref:'main',
    expected_base_sha:'b'.repeat(40),
  },
});

test('admission rejects unordered refresh effects for the same PR branch',()=>{
  const state:State={
    obligations:{
      alpha:prUpdateObligation('alpha','a'.repeat(40)),
      beta:prUpdateObligation('beta','c'.repeat(40)),
    },
    definition_ids:{alpha:'alpha-def',beta:'beta-def'},
  };
  assert.throws(
    ()=>validateAdmission(state),
    /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
  );
});

test('admission accepts explicit ordering for refreshes of the same PR branch',()=>{
  const state:State={
    obligations:{
      alpha:prUpdateObligation('alpha','a'.repeat(40)),
      beta:prUpdateObligation(
        'beta',
        'c'.repeat(40),
        [{kind:'control',upstream:'alpha'}],
      ),
    },
    definition_ids:{alpha:'alpha-def',beta:'beta-def'},
  };
  assert.doesNotThrow(()=>validateAdmission(state));
});
