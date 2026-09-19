import { createHash } from 'node:crypto';
import type { State } from '../../src/facts.ts';
import { executableFrontier } from '../../src/eligibility.ts';
import type { Lifecycle } from '../../src/lifecycle.ts';
import type { Obligation } from '../../src/model.ts';
import type { GraphExecutionEnvelope } from './adapter.ts';

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

function fileObligation(
  id:string,
  dependencies:Obligation['dependencies']=[],
):Obligation {
  return {
    id,
    dependencies,
    packet:{kind:'go-graph-concurrency-stress',id},
    postcondition:{
      verifier:'file-content-equals/v1',
      path:`/provider/${id}`,
      content:`content:${id}`,
    },
  };
}

function conflictObligation(
  id:string,
  pair:number,
  expected_state:'success'|'failure',
):Obligation {
  return {
    id,
    dependencies:[],
    packet:{kind:'go-graph-conflict-stress',pair},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:pair.toString(16).padStart(40,'0'),
      context:`overcenter/conflict/${pair}`,
      expected_state,
    },
  };
}

export interface StressGraph {
  state:State;
  lifecycles:Map<string,Lifecycle>;
  frontier:Obligation[];
}

export function buildStressGraph():StressGraph {
  const state:State={obligations:{},definition_commits:{}};
  const lifecycles=new Map<string,Lifecycle>();
  const add=(obligation:Obligation)=>{
    state.obligations[obligation.id]=obligation;
    state.definition_commits[obligation.id]=`definition:${obligation.id}`;
  };

  for (let index=0;index<700;index+=1) {
    add(fileObligation(`independent-${String(index).padStart(3,'0')}`));
  }

  for (let chain=0;chain<10;chain+=1) {
    let upstream:string|null=null;
    for (let depth=0;depth<10;depth+=1) {
      const id=`chain-${String(chain).padStart(2,'0')}-${String(depth).padStart(2,'0')}`;
      add(fileObligation(
        id,
        upstream ? [{kind:'control',upstream}] : [],
      ));
      upstream=id;
    }
  }

  for (let pair=0;pair<50;pair+=1) {
    add(conflictObligation(`conflict-${String(pair).padStart(2,'0')}-success`,pair,'success'));
    add(conflictObligation(`conflict-${String(pair).padStart(2,'0')}-failure`,pair,'failure'));
  }

  for (let index=0;index<50;index+=1) {
    const id=`reused-${String(index).padStart(2,'0')}`;
    add(fileObligation(id));
    lifecycles.set(id,{status:'DONE'});
  }

  for (let index=0;index<25;index+=1) {
    add(fileObligation(`fail-${String(index).padStart(2,'0')}`));
    add(fileObligation(`hang-${String(index).padStart(2,'0')}`));
  }

  return {
    state,
    lifecycles,
    frontier:executableFrontier(state,lifecycles),
  };
}

export function syntheticEnvelope(
  obligation:Obligation,
  index:number,
):GraphExecutionEnvelope {
  const capability=`capability:${obligation.id}`;
  const executionSpec={
    delay_ms:index===0 ? 20 : index%3,
    result:`candidate:${obligation.id}`,
    fail:obligation.id.startsWith('fail-'),
    wait_for_cancel:obligation.id.startsWith('hang-'),
  };
  const executionSpecJson=JSON.stringify(executionSpec);
  return {
    run_id:`run:${obligation.id}`,
    obligation_id:obligation.id,
    claimed_revision:'stress-frontier-revision',
    execution_generation:1,
    execution_authority_commit:`authority:${obligation.id}`,
    execution_capability:capability,
    execution_capability_sha256:sha256(capability),
    execution_spec_sha256:`sha256:${sha256(executionSpecJson)}`,
    execution_spec:executionSpec,
  };
}

export function stressPlan():GraphExecutionEnvelope[] {
  const {frontier}=buildStressGraph();
  return frontier.map(syntheticEnvelope);
}
