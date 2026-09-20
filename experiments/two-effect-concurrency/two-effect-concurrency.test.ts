import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { OvercenterKernel } from '../../src/kernel.ts';

const sqliteSourceUrl = new URL('../../src/kernel.ts', import.meta.url).href;
const sourceUrl = new URL('../../src/git-kernel.ts', import.meta.url).href;
const pc = (path: string, content: string) => ({
  verifier: 'file-content-equals/v1' as const,
  path,
  content,
});

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'overcenter-two-effect-'));
  const authority=join(root,'authority.git');
  execFileSync('git',['init','--bare',authority],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(authority);
  kernel.initialize();
  return {root,authority,kernel,path:(name:string)=>join(root,name)};
}

function cloneAgent(authority:string,path:string) {
  execFileSync('git',['init','--bare',path],{stdio:'ignore'});
  execFileSync('git',['-C',path,'remote','add','origin',authority],{stdio:'ignore'});
  execFileSync('git',['-C',path,'fetch','--no-tags','origin','+refs/overcenter/state:refs/overcenter/state'],{stdio:'ignore'});
}

function child(code:string,args:string[]) {
  return new Promise<{exitCode:number|null;stdout:string;stderr:string}>(resolve=>{
    const p=spawn(
      process.execPath,
      ['--experimental-strip-types','--input-type=module','-e',code,...args],
      {stdio:['ignore','pipe','pipe']},
    );
    let stdout='',stderr='';
    p.stdout.on('data',chunk=>{stdout+=chunk;});
    p.stderr.on('data',chunk=>{stderr+=chunk;});
    p.on('close',exitCode=>resolve({exitCode,stdout,stderr}));
  });
}

async function wait(paths:string[]) {
  for (let i=0;i<5000;i+=1) {
    if (paths.every(existsSync)) return;
    await new Promise(resolve=>setTimeout(resolve,2));
  }
  throw new Error('barrier timeout');
}

test('generic workers independently consume a parallel graph frontier', async () => {
  const root=mkdtempSync(join(tmpdir(),'overcenter-parallel-frontier-'));
  const barrier=mkdtempSync(join(tmpdir(),'overcenter-parallel-frontier-barrier-'));
  const database=join(root,'authority.sqlite');
  const kernel=new OvercenterKernel(database);
  const path=(name:string)=>join(root,name);

  try {
    kernel.initialize();
    kernel.define({
      id:'seed',
      packet:{path:path('seed'),content:'seed'},
      postcondition:pc(path('seed'),'seed'),
    });
    for (const id of ['left','right']) {
      kernel.define({
        id,
        dependencies:[{kind:'control',upstream:'seed'}],
        packet:{branch:id,path:path(id),content:id},
        postcondition:pc(path(id),id),
      });
    }
    kernel.define({
      id:'join',
      dependencies:[
        {kind:'control',upstream:'left'},
        {kind:'control',upstream:'right'},
      ],
      packet:{path:path('join'),content:'join'},
      postcondition:pc(path('join'),'join'),
    });

    const seed=kernel.deriveReadyWork()!;
    assert.equal(seed.id,'seed');
    const seedRun=kernel.claim(seed.id,seed.revision);
    writeFileSync(path('seed'),'seed');
    assert.equal(kernel.resolve(seedRun).disposition,'DONE');

    const start=join(barrier,'start');
    const go=join(barrier,'go');
    const armed=[join(barrier,'armed-1'),join(barrier,'armed-2')];
    const ready=[join(barrier,'ready-1'),join(barrier,'ready-2')];
    const code=`
      import { existsSync, writeFileSync } from 'node:fs';
      import { OvercenterKernel, runCoreLoop } from ${JSON.stringify(sqliteSourceUrl)};
      const [database,armed,ready,start,go]=process.argv.slice(1);
      const kernel=new OvercenterKernel(database);
      try {
        writeFileSync(armed,'armed');
        while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
        const result=await runCoreLoop(kernel,{
          maxAdvances:1,
          effect:async packet=>{
            writeFileSync(ready,JSON.stringify({branch:packet.branch,pid:process.pid}));
            while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
            writeFileSync(String(packet.path),String(packet.content));
            return {kind:'ok'};
          },
        });
        process.stdout.write(JSON.stringify({ok:true,result}));
      } catch (error) {
        process.stdout.write(JSON.stringify({ok:false,error:error.message}));
        process.exitCode=1;
      } finally {
        kernel.close();
      }
    `;

    const workers=[
      child(code,[database,armed[0],ready[0],start,go]),
      child(code,[database,armed[1],ready[1],start,go]),
    ];
    await wait(armed);
    writeFileSync(start,'start');
    await wait(ready);

    const active=ready.map(file=>JSON.parse(readFileSync(file,'utf8')));
    assert.deepEqual(active.map(item=>item.branch).sort(),['left','right']);
    assert.notEqual(active[0].pid,active[1].pid);

    const mid=new Map(kernel.inspect().map(work=>[work.id,work]));
    for (const id of ['left','right']) {
      const work=mid.get(id)!;
      assert.equal(work.status,'EXECUTING');
      assert.ok(work.run_id);
      assert.equal(kernel.hasUnresolvedEffect(work.run_id),true);
    }
    assert.equal(mid.get('join')?.status,'BLOCKED');

    writeFileSync(go,'go');
    const results=await Promise.all(workers);
    assert.ok(results.every(result=>result.exitCode===0),JSON.stringify(results));
    assert.ok(results.map(result=>JSON.parse(result.stdout))
      .every(result=>result.ok && result.result.advances===1));

    const after=new Map(kernel.inspect().map(work=>[work.id,work.status]));
    assert.equal(after.get('left'),'DONE');
    assert.equal(after.get('right'),'DONE');
    assert.equal(after.get('join'),'READY');

    const joinWork=kernel.deriveReadyWork()!;
    assert.equal(joinWork.id,'join');
    const joinRun=kernel.claim(joinWork.id,joinWork.revision);
    writeFileSync(path('join'),'join');
    assert.equal(kernel.resolve(joinRun).disposition,'DONE');
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
    rmSync(barrier,{recursive:true,force:true});
  }
});

test('claim identity remains exact after later claims move authority', () => {
  const f=fixture();
  try {
    const a=f.path('a');
    const b=f.path('b');
    f.kernel.define({id:'a',postcondition:pc(a,'A')});
    f.kernel.define({id:'b',postcondition:pc(b,'B')});

    const runA=f.kernel.claim('a',f.kernel.deriveReadyWork()!.revision);
    const runB=f.kernel.claim('b',f.kernel.deriveReadyWork()!.revision);
    writeFileSync(a,'A');

    f.kernel.recoverInterrupted(runB,{source:'test',order:'first'});
    const recoveryA=f.kernel.recoverInterrupted(runA,{source:'test',order:'second'});
    assert.equal(recoveryA.claim_commit,runA.claim_commit);

    const bAbsent=f.kernel.reconcile(runB);
    const aDone=f.kernel.reconcile(runA);
    assert.equal(bAbsent.disposition,'READY');
    assert.equal(aDone.disposition,'DONE');
    assert.equal(aDone.claim_commit,runA.claim_commit);

    const retryB=f.kernel.claim('b',f.kernel.deriveReadyWork()!.revision);
    writeFileSync(b,'B');
    const bDone=f.kernel.resolve(retryB);
    assert.equal(bDone.disposition,'DONE');
    assert.deepEqual(
      f.kernel.inspect().map(work=>[work.id,work.status]),
      [['a','DONE'],['b','DONE']],
    );
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('two fresh recovery processes concurrently settle independent effects through one ref', async () => {
  const f=fixture();
  const barrier=mkdtempSync(join(tmpdir(),'overcenter-two-resolve-barrier-'));
  try {
    const a=f.path('a'), b=f.path('b');
    f.kernel.define({id:'a',postcondition:pc(a,'A')});
    f.kernel.define({id:'b',postcondition:pc(b,'B')});
    const runA=f.kernel.claim('a',f.kernel.deriveReadyWork()!.revision);
    const runB=f.kernel.claim('b',f.kernel.deriveReadyWork()!.revision);
    writeFileSync(a,'A');
    writeFileSync(b,'B');

    const go=join(barrier,'go');
    const readyA=join(barrier,'ready-a');
    const readyB=join(barrier,'ready-b');
    const cloneA=join(f.root,'recovery-a.git');
    const cloneB=join(f.root,'recovery-b.git');
    cloneAgent(f.authority,cloneA);
    cloneAgent(f.authority,cloneB);

    const code=`
      import { existsSync, writeFileSync } from 'node:fs';
      import { GitOvercenterKernel } from ${JSON.stringify(sourceUrl)};
      const [repo,runId,ready,go]=process.argv.slice(1);
      const kernel=new GitOvercenterKernel(repo,{remote:'origin'});
      kernel.inspect();
      writeFileSync(ready,'ready');
      while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
      try {
        const permit=kernel.acquireExecution(runId);
        const receipt=kernel.resolve(permit);
        process.stdout.write(JSON.stringify({ok:true,receipt,generation:permit.execution_generation}));
      } catch (error) {
        process.stdout.write(JSON.stringify({ok:false,error:error.message}));
      }
    `;
    const pa=child(code,[cloneA,runA.id,readyA,go]);
    const pb=child(code,[cloneB,runB.id,readyB,go]);
    await wait([readyA,readyB]);
    writeFileSync(go,'go');

    const results=(await Promise.all([pa,pb])).map(x=>JSON.parse(x.stdout));
    assert.ok(results.every(x=>x.ok),JSON.stringify(results));
    assert.ok(results.every(x=>x.receipt.disposition==='DONE'));
    assert.ok(results.every(x=>x.generation===2));

    const final=f.kernel.inspect();
    assert.deepEqual(final.map(work=>[work.id,work.status]),[['a','DONE'],['b','DONE']]);
    assert.equal(f.kernel.receipts(runA.id).at(-1)?.claim_commit,runA.claim_commit);
    assert.equal(f.kernel.receipts(runB.id).at(-1)?.claim_commit,runB.claim_commit);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
    rmSync(barrier,{recursive:true,force:true});
  }
});
