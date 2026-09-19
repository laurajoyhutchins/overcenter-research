import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

const server=
  './experiments/lean-kernel/.lake/build/bin/overcenterClaimAdmissionComparisonServer';

const nodeCount=5;
const ids=Array.from({length:nodeCount},(_,i)=>`n-${i}`);
const edgeSlots:Array<[number,number]>=[];
for(let downstream=1;downstream<nodeCount;downstream++){
  for(let upstream=0;upstream<downstream;upstream++){
    edgeSlots.push([downstream,upstream]);
  }
}

function graphFromMask(mask:number):number[][]{
  const deps=Array.from({length:nodeCount},()=>[] as number[]);
  edgeSlots.forEach(([downstream,upstream],bit)=>{
    if((mask&(1<<bit))!==0)deps[downstream].push(upstream);
  });
  return deps;
}

function requestFor(
  deps:number[][],
  target:number,
  competitor:number,
  order:number[],
){
  return {
    command:'claim-admission',
    current_revision:'r1',
    expected_revision:'r1',
    target_id:ids[target],
    obligations:order.map(i=>({
      id:ids[i],
      dependencies:deps[i].map(upstream=>({
        upstream:ids[upstream],
        kind:'control',
        semantic_identity:null,
      })),
      effect:i===target
        ?{
            resource:'resource:shared',
            desired:'success',
            same_desired_commutes:true,
          }
        :i===competitor
          ?{
              resource:'resource:shared',
              desired:'failure',
              same_desired_commutes:true,
            }
          :null,
    })),
    lifecycles:order.map(i=>({
      obligation_id:ids[i],
      status:i===target?'UNREALIZED':'DONE',
    })),
  };
}

class ComparisonServer{
  child=spawn(server,[],{stdio:['pipe','pipe','pipe']});
  buffer='';
  stderr='';
  pending:Array<{
    resolve:(value:any)=>void;
    reject:(error:Error)=>void;
  }>=[];
  constructor(){
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data',(chunk:string)=>{this.stderr+=chunk;});
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
          next.resolve(JSON.parse(line));
        }catch(error){
          next.reject(error as Error);
        }
      }
    });
    this.child.on('exit',(code)=>{
      if(code===0)return;
      const error=new Error(
        `comparison server exited ${code}: ${this.stderr}`,
      );
      for(const item of this.pending.splice(0))item.reject(error);
    });
  }
  request(request:unknown):Promise<any>{
    return new Promise((resolve,reject)=>{
      this.pending.push({resolve,reject});
      this.child.stdin.write(JSON.stringify(request)+'\n');
    });
  }
  async close(){
    this.child.stdin.end();
    const [code]=await once(this.child,'exit');
    assert.equal(code,0,this.stderr);
  }
}

test('optimized effect ordering equals retained reference on every small DAG',async()=>{
  const comparison=new ComparisonServer();
  let comparisons=0;
  const orders=[
    Array.from({length:nodeCount},(_,i)=>i),
    Array.from({length:nodeCount},(_,i)=>nodeCount-1-i),
  ];
  try{
    for(let mask=0;mask<(1<<edgeSlots.length);mask++){
      const deps=graphFromMask(mask);
      for(const order of orders){
        for(let target=0;target<nodeCount;target++){
          for(let competitor=0;competitor<nodeCount;competitor++){
            if(competitor===target)continue;
            const result=await comparison.request(
              requestFor(deps,target,competitor,order),
            );
            assert.equal(
              result.graph_acyclic,
              true,
              `canonical DAG rejected mask=${mask} target=${target} competitor=${competitor} order=${order}`,
            );
            assert.equal(
              result.optimized_dependencies_done,
              result.reference_dependencies_done,
              `dependency mismatch mask=${mask} target=${target} competitor=${competitor} order=${order}`,
            );
            assert.equal(
              result.optimized_effect_conflict,
              result.reference_effect_conflict,
              `effect mismatch mask=${mask} target=${target} competitor=${competitor} order=${order}`,
            );
            comparisons++;
          }
        }
      }
    }
  }finally{
    await comparison.close();
  }
  console.log('EXHAUSTIVE_EFFECT_DIFFERENTIAL '+JSON.stringify({
    node_count:nodeCount,
    possible_edges:edgeSlots.length,
    dags:1<<edgeSlots.length,
    obligation_orders:orders.length,
    target_competitor_pairs:nodeCount*(nodeCount-1),
    comparisons,
  }));
});
