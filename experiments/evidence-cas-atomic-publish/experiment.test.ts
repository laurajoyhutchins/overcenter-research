import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  AtomicFileCas,
  evidenceBytes,
  evidenceDigest,
} from './store.ts';

function percentile(values:number[],p:number):number {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))]!;
}

function worker(dir:string,phase='none') {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types','experiments/evidence-cas-atomic-publish/worker.ts',dir,phase],
    {encoding:'utf8'},
  );
}

function concurrentWorker(dir:string):Promise<{code:number|null;stderr:string}> {
  return new Promise((resolve,reject)=>{
    const child=spawn(
      process.execPath,
      ['--experimental-strip-types','experiments/evidence-cas-atomic-publish/worker.ts',dir,'none'],
      {stdio:['ignore','ignore','pipe']},
    );
    let stderr='';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',reject);
    child.on('exit',code=>resolve({code,stderr}));
  });
}

test('filesystem CAS atomic publication survives crashes and duplicate races',async()=>{
  const root=mkdtempSync(join(tmpdir(),'atomic-evidence-cas-'));
  const bytes=evidenceBytes();
  const id=evidenceDigest(bytes);

  try {
    {
      const dir=join(root,'crash-temp');
      const cas=new AtomicFileCas(dir);
      const result=worker(dir,'after-temp-fsync');
      assert.equal(result.signal,'SIGKILL');
      assert.equal(cas.objectNames().length,0);
      assert.equal(cas.tempNames().length,1);
      assert.deepEqual(readFileSync(join(dir,cas.tempNames()[0]!)),bytes);
      assert.equal(cas.sweepTemps(),1);
      assert.equal(cas.tempNames().length,0);
    }

    {
      const dir=join(root,'crash-link');
      const cas=new AtomicFileCas(dir);
      const result=worker(dir,'after-link-fsync');
      assert.equal(result.signal,'SIGKILL');
      assert.deepEqual(cas.get(id),bytes);
      assert.equal(cas.objectNames().length,1);
      assert.equal(cas.tempNames().length,1);
      assert.equal(cas.sweepTemps(),1);
      assert.deepEqual(cas.get(id),bytes);
    }

    {
      const dir=join(root,'concurrent');
      const cas=new AtomicFileCas(dir);
      const results=await Promise.all(
        Array.from({length:8},()=>concurrentWorker(dir)),
      );
      for (const result of results) assert.equal(result.code,0,result.stderr);
      assert.deepEqual(cas.objectNames(),[id]);
      assert.equal(cas.tempNames().length,0);
      assert.deepEqual(cas.get(id),bytes);

      const duplicate=cas.put(bytes);
      assert.equal(duplicate.created,false);
      assert.equal(duplicate.id,id);
    }

    {
      const dir=join(root,'corrupt-existing');
      const cas=new AtomicFileCas(dir);
      writeFileSync(cas.path(id),bytes.subarray(0,1024));
      assert.throws(()=>cas.put(bytes),/EVIDENCE_EXISTING_DIGEST_MISMATCH/);
      assert.throws(()=>cas.get(id),/EVIDENCE_EXISTING_DIGEST_MISMATCH/);
    }

    {
      const dir=join(root,'reopen');
      let cas=new AtomicFileCas(dir);
      assert.equal(cas.put(bytes).created,true);
      cas=new AtomicFileCas(dir);
      assert.deepEqual(cas.get(id),bytes);
    }

    const perfDir=join(root,'perf');
    const cas=new AtomicFileCas(perfDir);
    const first:number[]=[];
    const duplicate:number[]=[];
    const reads:number[]=[];
    for (let i=0;i<32;i+=1) {
      const item=Buffer.from(bytes);
      item.writeUInt32BE(i,0);
      const start=performance.now();
      cas.put(item);
      first.push((performance.now()-start)*1000);
    }
    for (const name of cas.objectNames()) {
      const item=cas.get(name);
      let start=performance.now();
      cas.put(item);
      duplicate.push((performance.now()-start)*1000);
      start=performance.now();
      cas.get(name);
      reads.push((performance.now()-start)*1000);
    }

    console.log('EVIDENCE_CAS_ATOMIC_PUBLISH_RESULT '+JSON.stringify({
      schema:'overcenter-evidence-cas-atomic-publish-result/v1',
      crash_after_temp_fsync:'absent-final-complete-temp',
      crash_after_link_fsync:'valid-final-complete-temp',
      concurrent_writers:8,
      corrupt_existing:'rejected',
      first_put_p50_us:Number(percentile(first,0.50).toFixed(3)),
      first_put_p95_us:Number(percentile(first,0.95).toFixed(3)),
      duplicate_put_p50_us:Number(percentile(duplicate,0.50).toFixed(3)),
      verified_read_p50_us:Number(percentile(reads,0.50).toFixed(3)),
      false_accepts:0,
    }));
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
