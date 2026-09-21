import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function fairnessWitness() {
  const root=mkdtempSync(join(tmpdir(),'overcenter-fairness-'));
  const db=join(root,'authority.sqlite');
  const kernel=new OvercenterKernel(db);
  try {
    kernel.initialize();
    define(kernel,root,'a');
    define(kernel,root,'b');

    const selected=[];
    for (let i=0;i<8;i+=1) {
      const ready=kernel.deriveReadyWork();
      assert.ok(ready);
      selected.push(ready.id);
      assert.equal(ready.id,'a');
      const permit=kernel.claim(ready.id,ready.revision);
      const receipt=kernel.resolve(permit);
      assert.equal(receipt.disposition,'READY');
    }

    const b=kernel.inspect().find(work=>work.id==='b');
    assert.equal(b?.status,'READY');
    const result={
      kind:'fairness-witness',
      starvation_reproduced:true,
      selections:selected,
      continuously_ready_unselected:'b',
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
}

async function worker(db) {
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
      assert.ok(packet && typeof packet==='object');
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

    assert.ok(kernel.inspect().every(work=>work.status==='DONE'),'worker budget exhausted before project completion');
    process.stdout.write(JSON.stringify({completed,retries,idle})+'\n');
  } finally {
    kernel.close();
  }
}

function spawnWorker(db) {
  return new Promise((resolve,reject)=>{
    const child=spawn(
      process.execPath,
      ['--experimental-strip-types',here,'--worker',db],
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

async function scalingCase(workers) {
  const root=mkdtempSync(join(tmpdir(),`overcenter-scaling-${workers}-`));
  const db=join(root,'authority.sqlite');
  const setup=new OvercenterKernel(db);
  try {
    setup.initialize();
    for (let i=0;i<TASKS;i+=1) {
      define(setup,root,'task-'+String(i).padStart(4,'0'));
    }
  } finally {
    setup.close();
  }

  try {
    const started=performance.now();
    const summaries=await Promise.all(
      Array.from({length:workers},()=>spawnWorker(db)),
    );
    const elapsed_ms=performance.now()-started;

    const verify=new OvercenterKernel(db);
    try {
      const projected=verify.inspect();
      assert.equal(projected.length,TASKS);
      assert.ok(projected.every(work=>work.status==='DONE'));
    } finally {
      verify.close();
    }

    const completed=summaries.reduce((sum,item)=>sum+item.completed,0);
    assert.equal(completed,TASKS);
    const result={
      kind:'scaling-case',
      workers,
      tasks:TASKS,
      elapsed_ms:Number(elapsed_ms.toFixed(3)),
      tasks_per_second:Number((TASKS/(elapsed_ms/1000)).toFixed(3)),
      retries:summaries.reduce((sum,item)=>sum+item.retries,0),
      idle_polls:summaries.reduce((sum,item)=>sum+item.idle,0),
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
}

async function main() {
  fairnessWitness();
  const results=[];
  for (const workers of WORKERS) results.push(await scalingCase(workers));
  const baseline=results[0].tasks_per_second;
  console.log(JSON.stringify({
    kind:'scaling-summary',
    results:results.map(result=>({
      workers:result.workers,
      tasks_per_second:result.tasks_per_second,
      speedup:Number((result.tasks_per_second/baseline).toFixed(3)),
      efficiency:Number((result.tasks_per_second/(baseline*result.workers)).toFixed(3)),
      retries:result.retries,
    })),
  }));
}

if (process.argv[2]==='--worker') {
  await worker(process.argv[3]);
} else {
  await main();
}
