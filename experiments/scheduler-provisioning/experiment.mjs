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

function setupCase(prefix) {
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

async function herdWorker(db) {
  const kernel=new OvercenterKernel(db);
  let completed=0;
  let retries=0;
  let idle=0;
  try {
    for (let step=0;step<100000;step+=1) {
      const projected=kernel.inspect();
      if (projected.every(work=>work.status==='DONE')) break;

      const ready=kernel.deriveReadyWork();
      if (!ready) {
        idle+=1;
        await sleep(1);
        continue;
      }

      let permit;
      try {
        permit=kernel.claim(ready.id,ready.revision);
      } catch (error) {
        if (!contention(error)) throw error;
        retries+=1;
        continue;
      }

      const packet=ready.packet;
      const path=String(packet.path);
      mkdirSync(dirname(path),{recursive:true});
      writeFileSync(path,String(packet.content));

      for (;;) {
        try {
          const receipt=kernel.resolve(permit);
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

    assert.ok(
      kernel.inspect().every(work=>work.status==='DONE'),
      'herd worker budget exhausted before project completion',
    );
    return {completed,retries,idle};
  } finally {
    kernel.close();
  }
}

async function assignedWorker(db,assignments) {
  const kernel=new OvercenterKernel(db);
  let completed=0;
  let retries=0;
  try {
    for (const {permit,packet} of assignments) {
      const path=String(packet.path);
      mkdirSync(dirname(path),{recursive:true});
      writeFileSync(path,String(packet.content));

      for (;;) {
        try {
          const receipt=kernel.resolve(permit);
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
    return {completed,retries,idle:0};
  } finally {
    kernel.close();
  }
}

function spawnWorker(mode,db,assignmentPath='') {
  return new Promise((resolve,reject)=>{
    const args=['--experimental-strip-types',here,'--worker',mode,db];
    if (assignmentPath) args.push(assignmentPath);
    const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});
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

function partitions(assignments,workers) {
  const result=Array.from({length:workers},()=>[]);
  assignments.forEach((assignment,index)=>{
    result[index%workers].push(assignment);
  });
  return result;
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

async function herdCase(workers) {
  const {root,db}=setupCase(`overcenter-herd-${workers}-`);
  try {
    const started=performance.now();
    const summaries=await Promise.all(
      Array.from({length:workers},()=>spawnWorker('herd',db)),
    );
    const elapsed=performance.now()-started;
    verifyDone(db);

    const completed=summaries.reduce((sum,item)=>sum+item.completed,0);
    assert.equal(completed,TASKS);
    return {
      mode:'herd',
      workers,
      tasks:TASKS,
      elapsed_ms:Number(elapsed.toFixed(3)),
      tasks_per_second:Number((TASKS/(elapsed/1000)).toFixed(3)),
      retries:summaries.reduce((sum,item)=>sum+item.retries,0),
      idle_polls:summaries.reduce((sum,item)=>sum+item.idle,0),
    };
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
}

async function provisionedCase(workers) {
  const {root,db}=setupCase(`overcenter-provisioned-${workers}-`);
  try {
    const started=performance.now();
    const provisioner=new OvercenterKernel(db);
    const assignments=[];
    const provisionStarted=performance.now();
    try {
      while (assignments.length<TASKS) {
        const ready=provisioner.deriveReadyWork();
        assert.ok(ready,'provisioner ran out of READY work');
        const permit=provisioner.claim(ready.id,ready.revision);
        assignments.push({permit,packet:ready.packet});
      }
    } finally {
      provisioner.close();
    }
    const provisionMs=performance.now()-provisionStarted;

    const groups=partitions(assignments,workers);
    const executionStarted=performance.now();
    const summaries=await Promise.all(groups.map((group,index)=>{
      const path=join(root,`assignments-${index}.json`);
      writeFileSync(path,JSON.stringify(group));
      return spawnWorker('assigned',db,path);
    }));
    const executionMs=performance.now()-executionStarted;
    const elapsed=performance.now()-started;
    verifyDone(db);

    const completed=summaries.reduce((sum,item)=>sum+item.completed,0);
    assert.equal(completed,TASKS);
    return {
      mode:'provisioned',
      workers,
      tasks:TASKS,
      provision_ms:Number(provisionMs.toFixed(3)),
      execution_ms:Number(executionMs.toFixed(3)),
      elapsed_ms:Number(elapsed.toFixed(3)),
      tasks_per_second:Number((TASKS/(elapsed/1000)).toFixed(3)),
      provisioned_per_second:Number((TASKS/(provisionMs/1000)).toFixed(3)),
      retries:summaries.reduce((sum,item)=>sum+item.retries,0),
      idle_polls:0,
    };
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
}

async function main() {
  const results=[];
  for (const workers of WORKERS) {
    const herd=await herdCase(workers);
    console.log(JSON.stringify({kind:'scheduler-provisioning-case',...herd}));
    const provisioned=await provisionedCase(workers);
    console.log(JSON.stringify({kind:'scheduler-provisioning-case',...provisioned}));
    results.push({
      workers,
      herd_tasks_per_second:herd.tasks_per_second,
      provisioned_tasks_per_second:provisioned.tasks_per_second,
      provisioned_vs_herd:Number(
        (provisioned.tasks_per_second/herd.tasks_per_second).toFixed(3),
      ),
      provision_ms:provisioned.provision_ms,
      provisioned_per_second:provisioned.provisioned_per_second,
      herd_retries:herd.retries,
      provisioned_retries:provisioned.retries,
    });
  }
  const one=results[0];
  console.log(JSON.stringify({
    kind:'scheduler-provisioning-summary',
    results:results.map(result=>({
      ...result,
      herd_speedup:Number(
        (result.herd_tasks_per_second/one.herd_tasks_per_second).toFixed(3),
      ),
      provisioned_speedup:Number(
        (result.provisioned_tasks_per_second/one.provisioned_tasks_per_second).toFixed(3),
      ),
    })),
  }));
}

if (process.argv[2]==='--worker') {
  const mode=process.argv[3];
  const db=process.argv[4];
  const result=mode==='herd'
    ? await herdWorker(db)
    : mode==='assigned'
      ? await assignedWorker(
          db,
          JSON.parse(readFileSync(process.argv[5],'utf8')),
        )
      : (()=>{throw new Error('UNKNOWN_WORKER_MODE');})();
  process.stdout.write(JSON.stringify(result)+'\n');
} else {
  await main();
}
