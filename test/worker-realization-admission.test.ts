import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256 } from '../src/digest.ts';
import {
  GitOvercenterKernel,
  runGitCoreLoop,
} from '../src/git-kernel.ts';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'overcenter-worker-realization-'));
  const repo=join(root,'authority.git');
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(repo);
  kernel.initialize();
  return {root,repo,kernel,path:(name:string)=>join(root,name)};
}

function realizationObligation(id:string,content:string) {
  const expected=sha256(content);
  return {
    id,
    packet:{command:'compile',target:'app'},
    postcondition:{
      verifier:'realization-content/v1' as const,
      expected_sha256:expected,
    },
    realization:{
      verifier_identity:'artifact-sha256/v1',
      material_configuration:{target:'test-linux-x64'},
      source_inputs:{source:'tree-1'},
      acceptance_predicate:{
        kind:'sha256-equals/v1' as const,
        expected_sha256:expected,
      },
    },
  };
}

function commitsContaining(repo:string,path:string):string[] {
  const commits=execFileSync(
    'git',
    ['-C',repo,'rev-list','refs/overcenter/state'],
    {encoding:'utf8'},
  ).trim().split(/\n+/).filter(Boolean);
  return commits.filter(commit=>{
    try {
      execFileSync(
        'git',
        ['-C',repo,'cat-file','-e',`${commit}:${path}`],
        {stdio:'ignore'},
      );
      return true;
    } catch {
      return false;
    }
  });
}

test('worker candidate admission satisfies equivalent obligations with one worker execution',async()=>{
  const f=fixture();
  try {
    f.kernel.define(realizationObligation('build-a','artifact-v1'));
    f.kernel.define(realizationObligation('build-b','artifact-v1'));

    let workerExecutions=0;
    let effects=0;
    const result=await runGitCoreLoop(f.kernel,{
      realizationWorker:async packet=>{
        workerExecutions+=1;
        assert.deepEqual(packet,{command:'compile',target:'app'});
        return {
          producer:{kind:'agent',id:`worker-${workerExecutions}`},
          content:'artifact-v1',
        };
      },
      effect:async()=>{
        effects+=1;
        throw new Error('effect path must not execute for realization work');
      },
    });

    assert.equal(result.state,'IDLE');
    assert.equal(result.advances,1);
    assert.equal(workerExecutions,1);
    assert.equal(effects,0);

    const work=f.kernel.inspect();
    assert.deepEqual(work.map(item=>item.status),['DONE','DONE']);
    assert.equal(work[0].realization_identity,work[1].realization_identity);
    assert.equal(work[0].run_id,undefined);
    assert.equal(work[1].run_id,undefined);

    assert.equal(commitsContaining(f.repo,'realization.json').length,1);
    assert.equal(commitsContaining(f.repo,'claim.json').length,0);
    assert.equal(commitsContaining(f.repo,'effect-reservation.json').length,0);
    assert.equal(commitsContaining(f.repo,'receipt.json').length,0);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('invalid worker candidate is rejected without creating execution or realization facts',async()=>{
  const f=fixture();
  try {
    f.kernel.define(realizationObligation('build','artifact-v1'));

    await assert.rejects(
      runGitCoreLoop(f.kernel,{
        realizationWorker:async()=>({
          producer:{kind:'agent',id:'hostile-worker'},
          content:'wrong-artifact',
        }),
      }),
      /REALIZATION_REJECTED/,
    );

    const current=f.kernel.inspect()[0];
    assert.equal(current.status,'READY');
    assert.equal(current.run_id,undefined);
    assert.equal(current.realization_identity,undefined);
    assert.equal(commitsContaining(f.repo,'realization.json').length,0);
    assert.equal(commitsContaining(f.repo,'claim.json').length,0);
    assert.equal(commitsContaining(f.repo,'effect-reservation.json').length,0);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('mutable effects remain on the claimed reservation and observation path',async()=>{
  const f=fixture();
  try {
    const path=f.path('effect-output');
    f.kernel.define({
      id:'publish',
      packet:{path,content:'published'},
      postcondition:{
        verifier:'file-content-equals/v1',
        path,
        content:'published',
      },
    });

    let workerExecutions=0;
    let effects=0;
    const result=await runGitCoreLoop(f.kernel,{
      realizationWorker:async()=>{
        workerExecutions+=1;
        throw new Error('realization worker must not run for mutable effects');
      },
      effect:async packet=>{
        effects+=1;
        writeFileSync(packet.path as string,packet.content as string);
        return {kind:'ok'};
      },
    });

    assert.equal(result.state,'IDLE');
    assert.equal(result.advances,1);
    assert.equal(workerExecutions,0);
    assert.equal(effects,1);
    assert.equal(f.kernel.inspect()[0].status,'DONE');
    assert.equal(commitsContaining(f.repo,'claim.json').length,1);
    assert.equal(commitsContaining(f.repo,'effect-reservation.json').length,1);
    assert.equal(commitsContaining(f.repo,'receipt.json').length,1);
    assert.equal(commitsContaining(f.repo,'realization.json').length,0);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('missing execution machinery fails before creating lifecycle facts',async()=>{
  const f=fixture();
  try {
    f.kernel.define(realizationObligation('build','artifact-v1'));
    await assert.rejects(
      runGitCoreLoop(f.kernel,{}),
      /REALIZATION_WORKER_REQUIRED/,
    );
    assert.equal(f.kernel.inspect()[0].status,'READY');
    assert.equal(commitsContaining(f.repo,'claim.json').length,0);

    const path=f.path('effect');
    f.kernel.define({
      id:'effect',
      packet:{path,content:'yes'},
      postcondition:{
        verifier:'file-content-equals/v1',
        path,
        content:'yes',
      },
    });
    // build sorts before effect and remains READY, so satisfy it first without
    // creating a run, then verify the mutable-effect guard separately.
    f.kernel.recordRealization(
      'build',
      {producer:{kind:'human',id:'fixture'},content:'artifact-v1'},
      f.kernel.head()!,
    );

    await assert.rejects(
      runGitCoreLoop(f.kernel,{}),
      /EFFECT_HANDLER_REQUIRED/,
    );
    const effectWork=f.kernel.inspect().find(item=>item.id==='effect')!;
    assert.equal(effectWork.status,'READY');
    assert.equal(effectWork.run_id,undefined);
    assert.equal(commitsContaining(f.repo,'claim.json').length,0);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});
