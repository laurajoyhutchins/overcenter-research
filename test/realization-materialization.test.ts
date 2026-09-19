import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256 } from '../src/digest.ts';
import { GitFactStore } from '../src/git-store.ts';
import {
  GitOvercenterKernel,
  runGitCoreLoop,
} from '../src/git-kernel.ts';
import {
  REALIZATION_ARTIFACT_PATH,
  verifyRealizationCandidate,
  type RealizationContract,
} from '../src/realization.ts';

const STATE_REF='refs/overcenter/state';
const ARTIFACT='compiled-artifact-v1';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'overcenter-realization-materialization-'));
  const repo=join(root,'authority.git');
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(repo);
  kernel.initialize();
  return {root,repo,kernel};
}

function declaration(content=ARTIFACT) {
  return {
    verifier_identity:'artifact-sha256/v1',
    material_configuration:{target:'test-linux-x64'},
    source_inputs:{source:'tree-1'},
    acceptance_predicate:{
      kind:'sha256-equals/v1' as const,
      expected_sha256:sha256(content),
    },
  };
}

function obligation(id='build',content=ARTIFACT) {
  return {
    id,
    packet:{command:'compile',target:'app'},
    postcondition:{
      verifier:'realization-content/v1' as const,
      expected_sha256:sha256(content),
    },
    realization:declaration(content),
  };
}

function contract(content=ARTIFACT):RealizationContract {
  return {
    packet:{command:'compile',target:'app'},
    semantic_dependencies:[],
    ...declaration(content),
    reuse_mode:'content-addressed',
  };
}

function forgedFact(content=ARTIFACT) {
  return verifyRealizationCandidate(
    contract(content),
    {
      producer:{kind:'agent',id:'forger'},
      content,
    },
  );
}

test('materialization by immutable identity survives cache deletion and a fresh authority clone',async()=>{
  const f=fixture();
  try {
    f.kernel.define(obligation());

    let workerExecutions=0;
    const first=await runGitCoreLoop(f.kernel,{
      realizationWorker:async()=>{
        workerExecutions+=1;
        return {
          producer:{kind:'agent',id:'builder'},
          content:ARTIFACT,
        };
      },
    });

    assert.equal(first.state,'IDLE');
    assert.equal(workerExecutions,1);

    const work=f.kernel.inspect()[0];
    assert.equal(work.status,'DONE');
    assert.ok(work.realization_identity);
    const identity=work.realization_identity!;

    assert.equal(f.kernel.materializeRealization(identity),ARTIFACT);

    const cache=join(f.root,'materialized');
    mkdirSync(cache,{recursive:true});
    writeFileSync(join(cache,'artifact'),f.kernel.materializeRealization(identity));
    assert.equal(existsSync(cache),true);
    rmSync(cache,{recursive:true,force:true});
    assert.equal(existsSync(cache),false);

    const clone=join(f.root,'fresh.git');
    execFileSync('git',['init','--bare',clone],{stdio:'ignore'});
    execFileSync('git',['-C',clone,'remote','add','origin',f.repo]);
    execFileSync(
      'git',
      ['-C',clone,'fetch','--no-tags','origin',`+${STATE_REF}:${STATE_REF}`],
      {stdio:'ignore'},
    );

    const fresh=new GitOvercenterKernel(clone);
    assert.equal(fresh.inspect()[0].status,'DONE');
    assert.equal(fresh.materializeRealization(identity),ARTIFACT);

    let reruns=0;
    const reconstructed=await runGitCoreLoop(fresh,{
      realizationWorker:async()=>{
        reruns+=1;
        throw new Error('worker must not rerun for materializable realization');
      },
    });
    assert.equal(reconstructed.state,'IDLE');
    assert.equal(reruns,0);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('realization replay fails closed when the durable fact has no reachable artifact',()=>{
  const f=fixture();
  try {
    f.kernel.define(obligation());
    const store=new GitFactStore(f.repo,{ref:STATE_REF});
    const head=store.head()!;
    const commit=store.createCommit(
      head,
      'hostile realization without artifact',
      {'realization.json':forgedFact()},
    );
    assert.equal(store.cas(commit,head),true);

    assert.throws(
      ()=>f.kernel.inspect(),
      /REALIZATION_ARTIFACT_MISSING/,
    );
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('realization replay fails closed when reachable artifact bytes do not match identity',()=>{
  const f=fixture();
  try {
    f.kernel.define(obligation());
    const store=new GitFactStore(f.repo,{ref:STATE_REF});
    const head=store.head()!;
    const commit=store.createCommit(
      head,
      'hostile realization with mismatched artifact',
      {'realization.json':forgedFact()},
      {[REALIZATION_ARTIFACT_PATH]:'tampered-artifact'},
    );
    assert.equal(store.cas(commit,head),true);

    assert.throws(
      ()=>f.kernel.inspect(),
      /REALIZATION_ARTIFACT_DIGEST_MISMATCH/,
    );
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('unknown immutable identity cannot be materialized',async()=>{
  const f=fixture();
  try {
    f.kernel.define(obligation());
    await runGitCoreLoop(f.kernel,{
      realizationWorker:async()=>({
        producer:{kind:'agent',id:'builder'},
        content:ARTIFACT,
      }),
    });

    assert.throws(
      ()=>f.kernel.materializeRealization(`sha256:${'0'.repeat(64)}`),
      /REALIZATION_NOT_FOUND/,
    );
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});
