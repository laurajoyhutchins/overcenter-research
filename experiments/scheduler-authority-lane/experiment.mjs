import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { OvercenterKernel } from '../../src/kernel.ts';

const TASKS=32;
const WORKERS=[1,2,4,8];
const EFFECT_MS=[0,25,100];
const here=fileURLToPath(import.meta.url);
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const message=(error)=>error instanceof Error ? error.message : String(error);
const contention=(error)=>/STALE_REVISION|CLAIM_LOST|CONTENTION_EXHAUSTED|SQLITE_BUSY|database is locked/i.test(message(error));

function define(kernel,root,id) {
  const path=join(root,'out',id+'.txt');
  kernel.define({
    id,
    packet:{path,content:'done'},
    postcondition:{verifier:'file-content-equals/v1',path,content:'done'},
  });
}

function setup(prefix) {
  const root=mkdtempSync(join(tmpdir(),prefix));
  const db=join(root,'authority.sqlite');
  const kernel=new OvercenterKernel(db);
  try {
    kernel.initialize();
    for (let i=0;i<TASKS;i+=1) {
      define(kernel,root,'task-'+String(i).padStart(4,'0'));
    }
  } finally {
    kernel.close();
  }
  return {root,db};
}

function provision(db) {
  const kernel=new OvercenterKernel(db);
  const assignments=[];
  const started=performance.now();
  try {
    while (assignments.length<TASKS) {
      const ready=kernel.deriveReadyWork();
      assert.ok(ready,'provisioner ran out of READY work');
      const permit=kernel.claim(ready.id,ready.revision);
      assignments.push({
        id:ready.id,
        permit,
        packet:ready.packet,
      });
    }
  } finally {
    kernel.close();
  }
  return {
    assignments,
    elapsed_ms:performance.now()-started,
  };
}

function partitions(items,workers) {
  const groups=Array.from({length:workers},()=>[]);
  items.forEach((item,index)=>groups[index%workers].push(item));
  return groups;
}

async function effect(packet,effectMs) {
  if (effectMs>0) await sleep(effectMs);
  const path=String(packet.path);
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,String(packet.content));
}

async function distributedWorker(db,assignments,effectMs) {
  const kernel=new OvercenterKernel(db);
  let completed=0;
  let retries=0;
  try {
    for (const assignment of assignments) {
      await effect(assignment.packet,effectMs);
      for (;;) {
        try {
          const receipt=kernel.resolve(assignment.permit);
          assert.equal(receipt.disposition,'DONE');
          completed+=1;
          break;
        } catch (error) {
          if (!contention(error)) throw error;
          retries+=1;
          await sleep(1);
        }
      }
    }
    return {completed,retries};
  } finally {
    kernel.close();
  }
}

async function effectOnlyWorker(assignments,effectMs) {
  const completed=[];
  for (const assignment of assignments) {
    await effect(assignment.packet,effectMs);
    completed.push(assignment.id);
  }
  return {completed};
}

function spawnWorker(mode,db,assignmentPath,effectMs) {
  return new Promise((resolve,reject)=>{
    const child=spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        here,
        '--worker',
        mode,
        db,
        assignmentPath,
        String(effectMs),
      ],
      {stdio:['ignore','pipe','pipe']},
    );
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',reject);
    child.once('close',code=>{
      if (code!==0) {
        reject(new Error('worker failed: '+stderr));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error('invalid worker output: '+stdout+'\n'+stderr,{cause:error}));
      }
    });
  });
}

function writeAssignments(root,mode,assignments,workers) {
  return partitions(assignments,workers).map((group,index)=>{
    const payload=mode==='distributed'
      ? group
      : group.map(({id,packet})=>({id,packet}));
    const path=join(root,`${mode}-assignments-${index}.json`);
    writeFileSync(path,JSON.stringify(payload));
    return path;
  });
}

function verifyDone(db) {
  const kernel=new OvercenterKernel(db);
  try {
    const projected=kernel.inspect();
    assert.equal(projected.length,TASKS);
    assert.ok(projected.every(work=>work.status==='DONE'));
  } finally {
    kernel.close();
  }
}

async function distributedCase(workers,effectMs) {
  const {root,db}=setup(`overcenter-distributed-${workers}-${effectMs}-`);
  try {
    const started=performance.now();
    const provisioned=provision(db);
    const paths=writeAssignments(root,'distributed',provisioned.assignments,workers);
    const summaries=await Promise.all(
      paths.map(path=>spawnWorker('distributed',db,path,effectMs)),
    );
    const elapsed=performance.now()-started;
    verifyDone(db);

    assert.equal(
      summaries.reduce((sum,item)=>sum+item.completed,0),
      TASKS,
    );
    return {
      kind:'scheduler-authority-lane-case',
      mode:'distributed-settlement',
      workers,
      effect_ms:effectMs,
      tasks:TASKS,
      provision_ms:Number(provisioned.elapsed_ms.toFixed(3)),
      elapsed_ms:Number(elapsed.toFixed(3)),
      tasks_per_second:Number((TASKS/(elapsed/1000)).toFixed(3)),
      retries:summaries.reduce((sum,item)=>sum+item.retries,0),
    };
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
}

async function authorityLaneCase(workers,effectMs) {
  const {root,db}=setup(`overcenter-authority-lane-${workers}-${effectMs}-`);
  try {
    const started=performance.now();
    const provisioned=provision(db);
    const byId=new Map(
      provisioned.assignments.map(assignment=>[assignment.id,assignment]),
    );
    const paths=writeAssignments(root,'effect-only',provisioned.assignments,workers);

    const effectsStarted=performance.now();
    const summaries=await Promise.all(
      paths.map(path=>spawnWorker('effect-only',db,path,effectMs)),
    );
    const effectsMs=performance.now()-effectsStarted;

    const completedIds=summaries.flatMap(item=>item.completed);
    assert.equal(completedIds.length,TASKS);
    assert.equal(new Set(completedIds).size,TASKS);

    const settler=new OvercenterKernel(db);
    const settlementStarted=performance.now();
    try {
      for (const id of completedIds) {
        const assignment=byId.get(id);
        assert.ok(assignment);
        const receipt=settler.resolve(assignment.permit);
        assert.equal(receipt.disposition,'DONE');
      }
    } finally {
      settler.close();
    }
    const settlementMs=performance.now()-settlementStarted;
    const elapsed=performance.now()-started;
    verifyDone(db);

    return {
      kind:'scheduler-authority-lane-case',
      mode:'single-authority-lane',
      workers,
      effect_ms:effectMs,
      tasks:TASKS,
      provision_ms:Number(provisioned.elapsed_ms.toFixed(3)),
      effect_phase_ms:Number(effectsMs.toFixed(3)),
      settlement_ms:Number(settlementMs.toFixed(3)),
      elapsed_ms:Number(elapsed.toFixed(3)),
      tasks_per_second:Number((TASKS/(elapsed/1000)).toFixed(3)),
      retries:0,
      worker_received_execution_permit:false,
    };
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
}

async function main() {
  const all=[];
  for (const effectMs of EFFECT_MS) {
    for (const workers of WORKERS) {
      const distributed=await distributedCase(workers,effectMs);
      console.log(JSON.stringify(distributed));
      const lane=await authorityLaneCase(workers,effectMs);
      console.log(JSON.stringify(lane));
      all.push({
        workers,
        effect_ms:effectMs,
        distributed_tasks_per_second:distributed.tasks_per_second,
        lane_tasks_per_second:lane.tasks_per_second,
        lane_vs_distributed:Number(
          (lane.tasks_per_second/distributed.tasks_per_second).toFixed(3),
        ),
        distributed_retries:distributed.retries,
        lane_effect_ms:lane.effect_phase_ms,
        lane_settlement_ms:lane.settlement_ms,
      });
    }
  }

  console.log(JSON.stringify({
    kind:'scheduler-authority-lane-summary',
    results:all.map(result=>{
      const baseline=all.find(
        candidate=>
          candidate.effect_ms===result.effect_ms
          && candidate.workers===1,
      );
      assert.ok(baseline);
      return {
        ...result,
        distributed_speedup:Number(
          (result.distributed_tasks_per_second
            /baseline.distributed_tasks_per_second).toFixed(3),
        ),
        lane_speedup:Number(
          (result.lane_tasks_per_second
            /baseline.lane_tasks_per_second).toFixed(3),
        ),
      };
    }),
  }));
}

if (process.argv[2]==='--worker') {
  const mode=process.argv[3];
  const db=process.argv[4];
  const assignments=JSON.parse(readFileSync(process.argv[5],'utf8'));
  const effectMs=Number(process.argv[6]);
  const result=mode==='distributed'
    ? await distributedWorker(db,assignments,effectMs)
    : mode==='effect-only'
      ? await effectOnlyWorker(assignments,effectMs)
      : (()=>{throw new Error('UNKNOWN_WORKER_MODE');})();
  process.stdout.write(JSON.stringify(result)+'\n');
} else {
  await main();
}
