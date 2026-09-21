import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { normalizeObligation, OBLIGATION_SCHEMA } from '../../src/facts.ts';
import { OvercenterKernel } from '../../src/kernel.ts';
import { replayProjection } from '../../src/projection.ts';
import { SqliteFactStore } from '../../src/sqlite-store.ts';

const here=fileURLToPath(import.meta.url);
const HISTORY_COUNTS=[10,100,1000,5000];
const PROJECTION_COUNTS=[1,8,32,64,128];
const KERNEL_COUNTS=[1,8,32,64];
const GRAPH_BUILD_COUNTS=[8,32,64,128];
const WORKERS=[1,2,4,8];
const CAS_APPENDS=4096;

const median=(values)=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length/2)];
};

const timed=(fn,trials=5)=>{
  fn();
  const values=[];
  for (let i=0;i<trials;i+=1) {
    const started=performance.now();
    fn();
    values.push(performance.now()-started);
  }
  return median(values);
};

function syntheticDefinitionCommits(count) {
  const commits=[];
  let parent=null;
  for (let i=0;i<count;i+=1) {
    const id='task-'+String(i).padStart(5,'0');
    const commit='synthetic-'+String(i+1).padStart(6,'0');
    const obligation=normalizeObligation({
      id,
      packet:{kind:'projection-benchmark',id},
      postcondition:{
        verifier:'file-content-equals/v1',
        path:'/tmp/overcenter-projection/'+id,
        content:id,
      },
    });
    commits.push({
      commit,
      parent,
      obligation:{
        schema:OBLIGATION_SCHEMA,
        kind:'defined',
        obligation,
      },
      claim:null,
      execution_authority:null,
      effect_reservation:null,
      receipt:null,
    });
    parent=commit;
  }
  return commits;
}

function historyScanBenchmark() {
  const root=mkdtempSync(join(tmpdir(),'overcenter-history-scan-'));
  const db=join(root,'authority.sqlite');
  const store=new SqliteFactStore(db);
  try {
    let head=store.append(null,'overcenter: initialize');
    assert.ok(head);
    const heads=new Map([[1,head]]);
    for (let sequence=2;sequence<=HISTORY_COUNTS.at(-1);sequence+=1) {
      head=store.append(head,'overcenter: inert benchmark fact',{});
      assert.ok(head);
      if (HISTORY_COUNTS.includes(sequence)) heads.set(sequence,head);
    }

    const results=HISTORY_COUNTS.map(commits=>{
      const target=heads.get(commits);
      assert.ok(target);
      const median_ms=timed(()=>{
        const history=store.history(target);
        assert.equal(history.length,commits);
      });
      return {
        commits,
        median_ms:Number(median_ms.toFixed(3)),
        microseconds_per_commit:Number((median_ms*1000/commits).toFixed(3)),
      };
    });
    console.log(JSON.stringify({kind:'history-scan',results}));
    return results;
  } finally {
    store.close();
    rmSync(root,{recursive:true,force:true});
  }
}

function replayBenchmark() {
  const results=PROJECTION_COUNTS.map(definitions=>{
    const commits=syntheticDefinitionCommits(definitions);
    const median_ms=timed(()=>{
      const projection=replayProjection(commits);
      assert.equal(Object.keys(projection.state.obligations).length,definitions);
      assert.equal(projection.project.work.length,definitions);
    },3);
    return {
      definitions,
      median_ms:Number(median_ms.toFixed(3)),
      microseconds_per_definition:Number((median_ms*1000/definitions).toFixed(3)),
    };
  });
  console.log(JSON.stringify({kind:'projection-replay',results}));
  return results;
}

function kernelReadBenchmark() {
  const results=[];
  for (const definitions of KERNEL_COUNTS) {
    const root=mkdtempSync(join(tmpdir(),'overcenter-kernel-read-'));
    const db=join(root,'authority.sqlite');
    const kernel=new OvercenterKernel(db);
    try {
      kernel.initialize();
      for (let i=0;i<definitions;i+=1) {
        const id='task-'+String(i).padStart(5,'0');
        kernel.define({
          id,
          packet:{kind:'kernel-read-benchmark',id},
          postcondition:{
            verifier:'file-content-equals/v1',
            path:join(root,'out',id),
            content:id,
          },
        });
      }
      const median_ms=timed(()=>{
        const ready=kernel.deriveReadyWork();
        assert.ok(ready);
      },3);
      results.push({
        definitions,
        durable_commits:definitions+1,
        median_ms:Number(median_ms.toFixed(3)),
      });
    } finally {
      kernel.close();
      rmSync(root,{recursive:true,force:true});
    }
  }
  console.log(JSON.stringify({kind:'kernel-ready-read',results}));
  return results;
}

function graphBuildBenchmark() {
  const results=[];
  for (const definitions of GRAPH_BUILD_COUNTS) {
    const obligations=Array.from({length:definitions},(_,index)=>{
      const id='task-'+String(index).padStart(5,'0');
      return {
        id,
        ...(index===0
          ? {}
          : {dependencies:[{kind:'control',upstream:'task-'+String(index-1).padStart(5,'0')}]}),
        packet:{kind:'graph-build-benchmark',id},
        postcondition:{
          verifier:'file-content-equals/v1',
          path:'/tmp/overcenter-graph-build/'+id,
          content:id,
        },
      };
    });

    const measure=mode=>{
      const trials=[];
      for (let trial=0;trial<3;trial+=1) {
        const root=mkdtempSync(join(tmpdir(),'overcenter-graph-build-'));
        const db=join(root,'authority.sqlite');
        const kernel=new OvercenterKernel(db);
        try {
          const initial=kernel.initialize();
          const started=performance.now();
          if (mode==='sequential') {
            for (const obligation of obligations) kernel.define(obligation);
          } else {
            kernel.applyGraphPatch({add:obligations},initial);
          }
          const elapsed_ms=performance.now()-started;
          assert.equal(kernel.inspect().length,definitions);
          const store=new SqliteFactStore(db);
          try {
            const head=store.head();
            assert.ok(head);
            trials.push({
              elapsed_ms,
              durable_commits:store.history(head).length,
            });
          } finally {
            store.close();
          }
        } finally {
          kernel.close();
          rmSync(root,{recursive:true,force:true});
        }
      }
      return {
        median_ms:median(trials.map(item=>item.elapsed_ms)),
        durable_commits:trials[0].durable_commits,
      };
    };

    const sequential=measure('sequential');
    const batch=measure('batch');
    results.push({
      definitions,
      sequential_median_ms:Number(sequential.median_ms.toFixed(3)),
      batch_median_ms:Number(batch.median_ms.toFixed(3)),
      speedup:Number((sequential.median_ms/batch.median_ms).toFixed(3)),
      sequential_durable_commits:sequential.durable_commits,
      batch_durable_commits:batch.durable_commits,
    });
  }
  console.log(JSON.stringify({kind:'graph-build',results}));
  return results;
}

async function casWorker(db,count,workerId) {
  const store=new SqliteFactStore(db);
  let completed=0;
  let stale_retries=0;
  let busy_retries=0;
  try {
    while (completed<count) {
      const expected=store.head();
      try {
        const commit=store.append(
          expected,
          'overcenter: bare-cas '+workerId+' '+completed,
          {},
        );
        if (commit) completed+=1;
        else stale_retries+=1;
      } catch (error) {
        const msg=error instanceof Error ? error.message : String(error);
        if (/SQLITE_BUSY|database is locked/i.test(msg)) {
          busy_retries+=1;
          continue;
        }
        throw error;
      }
    }
    process.stdout.write(JSON.stringify({completed,stale_retries,busy_retries})+'\n');
  } finally {
    store.close();
  }
}

function spawnCasWorker(db,count,workerId) {
  return new Promise((resolve,reject)=>{
    const child=spawn(
      process.execPath,
      ['--experimental-strip-types',here,'--cas-worker',db,String(count),String(workerId)],
      {stdio:['ignore','pipe','pipe']},
    );
    let stdout='';
    let stderr='';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.once('error',reject);
    child.once('close',code=>{
      if (code!==0) {
        reject(new Error('CAS worker failed: '+stderr));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error('invalid CAS worker output: '+stdout+'\n'+stderr,{cause:error}));
      }
    });
  });
}

async function bareCasBenchmark() {
  const results=[];
  for (const workers of WORKERS) {
    assert.equal(CAS_APPENDS%workers,0);
    const trials=[];

    for (let trial=0;trial<3;trial+=1) {
      const root=mkdtempSync(join(tmpdir(),'overcenter-bare-cas-'));
      const db=join(root,'authority.sqlite');
      const setup=new SqliteFactStore(db);
      try {
        assert.ok(setup.append(null,'overcenter: initialize'));
      } finally {
        setup.close();
      }

      try {
        const perWorker=CAS_APPENDS/workers;
        const started=performance.now();
        const summaries=await Promise.all(
          Array.from(
            {length:workers},
            (_,index)=>spawnCasWorker(db,perWorker,index),
          ),
        );
        const elapsed_ms=performance.now()-started;
        const verify=new SqliteFactStore(db);
        try {
          const head=verify.head();
          assert.ok(head);
          assert.equal(verify.history(head).length,CAS_APPENDS+1);
        } finally {
          verify.close();
        }

        const completed=summaries.reduce((sum,item)=>sum+item.completed,0);
        assert.equal(completed,CAS_APPENDS);
        trials.push({
          elapsed_ms,
          stale_retries:summaries.reduce((sum,item)=>sum+item.stale_retries,0),
          busy_retries:summaries.reduce((sum,item)=>sum+item.busy_retries,0),
        });
      } finally {
        rmSync(root,{recursive:true,force:true});
      }
    }

    const median_elapsed_ms=median(trials.map(trial=>trial.elapsed_ms));
    results.push({
      workers,
      appends:CAS_APPENDS,
      trials:3,
      median_elapsed_ms:Number(median_elapsed_ms.toFixed(3)),
      appends_per_second:Number((CAS_APPENDS/(median_elapsed_ms/1000)).toFixed(3)),
      median_stale_retries:median(trials.map(trial=>trial.stale_retries)),
      median_busy_retries:median(trials.map(trial=>trial.busy_retries)),
      sample_appends_per_second:trials.map(
        trial=>Number((CAS_APPENDS/(trial.elapsed_ms/1000)).toFixed(3)),
      ),
    });
  }

  const baseline=results[0].appends_per_second;
  const withScaling=results.map(result=>({
    ...result,
    speedup:Number((result.appends_per_second/baseline).toFixed(3)),
    efficiency:Number((result.appends_per_second/(baseline*result.workers)).toFixed(3)),
  }));
  console.log(JSON.stringify({kind:'bare-authority-cas',results:withScaling}));
  return withScaling;
}

async function main() {
  const history=historyScanBenchmark();
  const replay=replayBenchmark();
  const kernel=kernelReadBenchmark();
  const graphBuild=graphBuildBenchmark();
  const cas=await bareCasBenchmark();

  console.log(JSON.stringify({
    kind:'bottleneck-summary',
    history_5000_ms:history.at(-1).median_ms,
    replay_128_ms:replay.at(-1).median_ms,
    kernel_ready_64_ms:kernel.at(-1).median_ms,
    graph_build_128_sequential_ms:graphBuild.at(-1).sequential_median_ms,
    graph_build_128_batch_ms:graphBuild.at(-1).batch_median_ms,
    graph_build_128_speedup:graphBuild.at(-1).speedup,
    bare_cas_1_worker_per_second:cas[0].appends_per_second,
    bare_cas_8_workers_per_second:cas.at(-1).appends_per_second,
  }));
}

if (process.argv[2]==='--cas-worker') {
  await casWorker(process.argv[3],Number(process.argv[4]),process.argv[5]);
} else {
  await main();
}
