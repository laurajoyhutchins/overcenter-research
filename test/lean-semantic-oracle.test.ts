import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import {
  staticEffectConflict,
} from '../src/admission.ts';
import type { State } from '../src/facts.ts';
import { validateGraph } from '../src/graph.ts';
import type {
  Dependency,
  Obligation,
  Postcondition,
} from '../src/model.ts';
import { effectSemantics } from '../src/semantics.ts';

const oracleBin=process.env.LEAN_ORACLE_BIN;
const oracleSha=process.env.LEAN_ORACLE_SHA;

if (!oracleBin) {
  throw new Error('LEAN_ORACLE_BIN is required');
}
if (!oracleSha || !/^[0-9a-f]{40}$/.test(oracleSha)) {
  throw new Error(
    `LEAN_ORACLE_SHA must be the exact 40-hex pinned reference; got ${oracleSha??'<unset>'}`,
  );
}

type LeanComparison = {
  schema:string;
  graph_acyclic:boolean;
  optimized_dependencies_done:boolean;
  reference_dependencies_done:boolean;
  optimized_effect_conflict:boolean;
  reference_effect_conflict:boolean;
};

class LeanOracle {
  readonly child=spawn(oracleBin,[],{stdio:['pipe','pipe','pipe']});
  buffer='';
  stderr='';
  pending:Array<{
    resolve:(value:LeanComparison)=>void;
    reject:(error:Error)=>void;
  }>=[];
  constructor(){
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data',(chunk:string)=>{
      this.stderr+=chunk;
    });
    this.child.stdout.on('data',(chunk:string)=>{
      this.buffer+=chunk;
      for(;;){
        const newline=this.buffer.indexOf('\n');
        if(newline<0)break;
        const line=this.buffer.slice(0,newline);
        this.buffer=this.buffer.slice(newline+1);
        const next=this.pending.shift();
        if(!next)continue;
        try{
          const value=JSON.parse(line) as LeanComparison;
          assert.equal(
            value.schema,
            'overcenter-lean-claim-admission-comparison/v1',
            'unexpected Lean oracle response schema',
          );
          next.resolve(value);
        }catch(error){
          next.reject(error as Error);
        }
      }
    });
    this.child.on('exit',(code)=>{
      if(code===0)return;
      const error=new Error(
        `Lean semantic oracle exited ${code}: ${this.stderr}`,
      );
      for(const item of this.pending.splice(0)){
        item.reject(error);
      }
    });
  }
  compare(request:unknown):Promise<LeanComparison>{
    return new Promise((resolve,reject)=>{
      this.pending.push({resolve,reject});
      this.child.stdin.write(JSON.stringify(request)+'\n');
    });
  }
  async close():Promise<void>{
    this.child.stdin.end();
    const [code]=await once(this.child,'exit');
    assert.equal(code,0,this.stderr);
  }
}

function filePostcondition(id:string):Postcondition{
  return {
    verifier:'file-content-equals/v1',
    path:`/tmp/oracle/${id}`,
    content:id,
  };
}

function statusPostcondition(
  desired:'success'|'failure',
  context='overcenter/lean-oracle',
):Postcondition{
  return {
    verifier:'github-commit-status/v1',
    provider:'github',
    repository_id:123,
    commit_sha:'a'.repeat(40),
    context,
    expected_state:desired,
  };
}

type DependencyKind='control'|'semantic';

function dependency(
  upstream:number|string,
  kind:DependencyKind,
):Dependency{
  const upstreamId=typeof upstream==='number'
    ?`n-${upstream}`
    :upstream;
  if(kind==='control'){
    return {kind:'control',upstream:upstreamId};
  }
  return {
    kind:'semantic',
    upstream:upstreamId,
    consumes:{
      kind:'evidence',
      selector:'settlement-receipt',
    },
  };
}

function obligation(
  id:string,
  upstreams:number[],
  postcondition:Postcondition=filePostcondition(id),
  dependencyKind:DependencyKind='control',
):Obligation{
  return {
    id,
    dependencies:upstreams.map(upstream=>dependency(
      upstream,
      dependencyKind,
    )),
    packet:{kind:'lean-semantic-oracle'},
    postcondition,
  };
}

interface EffectFixture {
  target:number;
  competitor:number;
  targetDesired:'success'|'failure';
  competitorDesired:'success'|'failure';
  competitorContext?:string;
}

function stateFromDependencies(
  dependencies:number[][],
  effect:EffectFixture|null=null,
  dependencyKind:DependencyKind='control',
):State{
  const obligations:Record<string,Obligation>={};
  const definition_commits:Record<string,string>={};
  for(let i=0;i<dependencies.length;i+=1){
    const id=`n-${i}`;
    const postcondition=i===effect?.target
      ?statusPostcondition(effect.targetDesired)
      :i===effect?.competitor
        ?statusPostcondition(
            effect.competitorDesired,
            effect.competitorContext,
          )
        :filePostcondition(id);
    obligations[id]=obligation(
      id,
      dependencies[i],
      postcondition,
      dependencyKind,
    );
    definition_commits[id]=`definition-${i}`;
  }
  return {obligations,definition_commits};
}

function typeScriptGraphValid(state:State):boolean{
  try{
    validateGraph(state);
    return true;
  }catch{
    return false;
  }
}

function leanEffect(postcondition:Postcondition){
  const semantics=effectSemantics(postcondition);
  return semantics
    ?{
        resource:semantics.resource,
        desired:semantics.desired,
        same_desired_commutes:semantics.sameDesiredCommutes,
      }
    :null;
}

function leanRequest(
  state:State,
  targetId:string,
  order:string[]=Object.keys(state.obligations),
){
  return {
    command:'claim-admission',
    current_revision:'oracle-revision',
    expected_revision:'oracle-revision',
    target_id:targetId,
    obligations:order.map(id=>{
      const item=state.obligations[id];
      return {
        id:item.id,
        dependencies:item.dependencies.map(edge=>({
          upstream:edge.upstream,
          kind:edge.kind,
          semantic_identity:null,
        })),
        effect:leanEffect(item.postcondition),
      };
    }),
    lifecycles:order.map(id=>({
      obligation_id:id,
      status:id===targetId?'UNREALIZED':'DONE',
    })),
  };
}

function allDirectedGraphSlots(nodeCount:number):Array<[number,number]>{
  const slots:Array<[number,number]>=[];
  for(let from=0;from<nodeCount;from+=1){
    for(let to=0;to<nodeCount;to+=1){
      if(from!==to)slots.push([from,to]);
    }
  }
  return slots;
}

function graphFromMask(
  nodeCount:number,
  slots:Array<[number,number]>,
  mask:number,
):number[][]{
  const dependencies=Array.from({length:nodeCount},()=>[] as number[]);
  for(let bit=0;bit<slots.length;bit+=1){
    if((mask&(1<<bit))===0)continue;
    const [from,to]=slots[bit];
    dependencies[from].push(to);
  }
  return dependencies;
}

function dagSlots(nodeCount:number):Array<[number,number]>{
  const slots:Array<[number,number]>=[];
  for(let downstream=1;downstream<nodeCount;downstream+=1){
    for(let upstream=0;upstream<downstream;upstream+=1){
      slots.push([downstream,upstream]);
    }
  }
  return slots;
}

test('current TypeScript graph validity agrees with pinned Lean semantic oracle',async()=>{
  const oracle=new LeanOracle();
  const nodeCount=4;
  const slots=allDirectedGraphSlots(nodeCount);
  const dependencyKinds:DependencyKind[]=['control','semantic'];
  let comparisons=0;
  let additionalCases=0;
  try{
    for(const dependencyKind of dependencyKinds){
      for(let mask=0;mask<(1<<slots.length);mask+=1){
        const state=stateFromDependencies(
          graphFromMask(nodeCount,slots,mask),
          null,
          dependencyKind,
        );
        const expected=typeScriptGraphValid(state);
        const observed=await oracle.compare(
          leanRequest(state,'n-0'),
        );
        assert.equal(
          observed.graph_acyclic,
          expected,
          `graph disagreement kind=${dependencyKind} mask=${mask}`,
        );
        comparisons+=1;
      }

      const unknown=stateFromDependencies(
        [[],[]],
        null,
        dependencyKind,
      );
      unknown.obligations['n-1'].dependencies=[
        dependency('missing',dependencyKind),
      ];
      assert.equal(typeScriptGraphValid(unknown),false);
      assert.equal(
        (await oracle.compare(
          leanRequest(unknown,'n-1'),
        )).graph_acyclic,
        false,
      );
      additionalCases+=1;

      const selfLoop=stateFromDependencies(
        [[]],
        null,
        dependencyKind,
      );
      selfLoop.obligations['n-0'].dependencies=[
        dependency(0,dependencyKind),
      ];
      assert.equal(typeScriptGraphValid(selfLoop),false);
      assert.equal(
        (await oracle.compare(
          leanRequest(selfLoop,'n-0'),
        )).graph_acyclic,
        false,
      );
      additionalCases+=1;

      const duplicateEdge=stateFromDependencies(
        [[],[0]],
        null,
        dependencyKind,
      );
      duplicateEdge.obligations['n-1'].dependencies.push(
        dependency(0,dependencyKind),
      );
      assert.equal(typeScriptGraphValid(duplicateEdge),true);
      assert.equal(
        (await oracle.compare(
          leanRequest(duplicateEdge,'n-1'),
        )).graph_acyclic,
        true,
      );
      additionalCases+=1;
    }

    const mixedCycle=stateFromDependencies([[1],[0]]);
    mixedCycle.obligations['n-1'].dependencies=[
      dependency(0,'semantic'),
    ];
    assert.equal(typeScriptGraphValid(mixedCycle),false);
    assert.equal(
      (await oracle.compare(
        leanRequest(mixedCycle,'n-0'),
      )).graph_acyclic,
      false,
    );
    additionalCases+=1;

    const mixedDag=stateFromDependencies([[],[0],[1]]);
    mixedDag.obligations['n-2'].dependencies=[
      dependency(1,'semantic'),
    ];
    assert.equal(typeScriptGraphValid(mixedDag),true);
    assert.equal(
      (await oracle.compare(
        leanRequest(mixedDag,'n-2'),
      )).graph_acyclic,
      true,
    );
    additionalCases+=1;
  }finally{
    await oracle.close();
  }

  console.log('LEAN_GRAPH_ORACLE '+JSON.stringify({
    oracle_sha:oracleSha,
    node_count:nodeCount,
    directed_graphs:1<<slots.length,
    dependency_kinds:dependencyKinds,
    additional_hostile_cases:additionalCases,
    comparisons,
  }));
});

test('current TypeScript effect ordering agrees with pinned Lean semantic oracle',async()=>{
  const oracle=new LeanOracle();
  const nodeCount=5;
  const slots=dagSlots(nodeCount);
  const forward=Array.from({length:nodeCount},(_,i)=>`n-${i}`);
  const reverse=[...forward].reverse();
  const dependencyKinds:DependencyKind[]=['control','semantic'];
  let comparisons=0;

  try{
    for(const dependencyKind of dependencyKinds){
      for(let mask=0;mask<(1<<slots.length);mask+=1){
        const dependencies=graphFromMask(nodeCount,slots,mask);
        for(let target=0;target<nodeCount;target+=1){
          for(let competitor=0;competitor<nodeCount;competitor+=1){
            if(target===competitor)continue;
            const scenarios:Array<{
              name:string;
              fixture:EffectFixture;
            }>=[
              {
                name:'conflicting-same-resource',
                fixture:{
                  target,
                  competitor,
                  targetDesired:'success',
                  competitorDesired:'failure',
                },
              },
              {
                name:'commuting-same-desired',
                fixture:{
                  target,
                  competitor,
                  targetDesired:'success',
                  competitorDesired:'success',
                },
              },
              {
                name:'independent-different-resource',
                fixture:{
                  target,
                  competitor,
                  targetDesired:'success',
                  competitorDesired:'failure',
                  competitorContext:'overcenter/lean-oracle/other',
                },
              },
            ];

            for(const scenario of scenarios){
              const state=stateFromDependencies(
                dependencies,
                scenario.fixture,
                dependencyKind,
              );
              const expected=
                staticEffectConflict(state,`n-${target}`)!==null;

              for(const order of [forward,reverse]){
                const observed=await oracle.compare(
                  leanRequest(state,`n-${target}`,order),
                );
                assert.equal(
                  observed.graph_acyclic,
                  true,
                  `oracle rejected canonical DAG kind=${dependencyKind} mask=${mask}`,
                );
                assert.equal(
                  observed.optimized_effect_conflict,
                  observed.reference_effect_conflict,
                  `Lean optimized/reference disagreement kind=${dependencyKind} scenario=${scenario.name} mask=${mask} target=${target} competitor=${competitor} order=${order.join(',')}`,
                );
                assert.equal(
                  observed.reference_effect_conflict,
                  expected,
                  `effect disagreement kind=${dependencyKind} scenario=${scenario.name} mask=${mask} target=${target} competitor=${competitor} order=${order.join(',')}`,
                );
                comparisons+=1;
              }
            }
          }
        }
      }
    }

    const mixedOrdered=stateFromDependencies(
      [[],[0],[1]],
      {
        target:2,
        competitor:0,
        targetDesired:'success',
        competitorDesired:'failure',
      },
    );
    mixedOrdered.obligations['n-1'].dependencies=[
      dependency(0,'semantic'),
    ];
    for(const order of [forward,reverse]){
      const observed=await oracle.compare(
        leanRequest(mixedOrdered,'n-2',order),
      );
      assert.equal(
        observed.optimized_effect_conflict,
        observed.reference_effect_conflict,
      );
      assert.equal(
        observed.reference_effect_conflict,
        staticEffectConflict(mixedOrdered,'n-2')!==null,
      );
      comparisons+=1;
    }

    const mixedUnordered=stateFromDependencies(
      [[],[],[1]],
      {
        target:2,
        competitor:0,
        targetDesired:'success',
        competitorDesired:'failure',
      },
    );
    mixedUnordered.obligations['n-2'].dependencies=[
      dependency(1,'semantic'),
    ];
    for(const order of [forward,reverse]){
      const observed=await oracle.compare(
        leanRequest(mixedUnordered,'n-2',order),
      );
      assert.equal(
        observed.optimized_effect_conflict,
        observed.reference_effect_conflict,
      );
      assert.equal(
        observed.reference_effect_conflict,
        staticEffectConflict(mixedUnordered,'n-2')!==null,
      );
      comparisons+=1;
    }
  }finally{
    await oracle.close();
  }

  console.log('LEAN_EFFECT_ORACLE '+JSON.stringify({
    oracle_sha:oracleSha,
    node_count:nodeCount,
    possible_edges:slots.length,
    dags:1<<slots.length,
    target_competitor_pairs:nodeCount*(nodeCount-1),
    dependency_kinds:dependencyKinds,
    effect_scenarios:3,
    obligation_orders:2,
    comparisons,
  }));
});
