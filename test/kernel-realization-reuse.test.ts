import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256 } from '../src/digest.ts';
import { GitOvercenterKernel } from '../src/git-kernel.ts';

const STATE_REF='refs/overcenter/state';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'overcenter-kernel-realization-'));
  const repo=join(root,'authority.git');
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(repo);
  kernel.initialize();
  return {root,repo,kernel,path:(name:string)=>join(root,name)};
}

function pc(path:string,content:string) {
  return {verifier:'file-content-equals/v1' as const,path,content};
}

function rpc(content:string) {
  return {
    verifier:'realization-content/v1' as const,
    expected_sha256:sha256(content),
  };
}

function realization(content:string,source='v1') {
  return {
    verifier_identity:'artifact-sha256/v1',
    material_configuration:{target:'test-linux-x64'},
    source_inputs:{source},
    acceptance_predicate:{
      kind:'sha256-equals/v1' as const,
      expected_sha256:sha256(content),
    },
  };
}

function settleFile(
  kernel:GitOvercenterKernel,
  id:string,
  path:string,
  content:string,
) {
  const ready=kernel.inspect().find(work=>work.id===id)!;
  assert.equal(ready.status,'READY');
  const run=kernel.claim(id,ready.revision);
  kernel.beginEffect(run);
  writeFileSync(path,content);
  const receipt=kernel.resolve(run);
  assert.equal(receipt.disposition,'DONE');
  return {run,receipt};
}

test('a verified realization satisfies work without executing a worker and survives non-material amendment',()=>{
  const f=fixture();
  try {
    const gate=f.path('gate');
    const artifact=f.path('artifact');
    f.kernel.define({id:'gate',postcondition:pc(gate,'ready')});
    f.kernel.define({
      id:'build',
      packet:{target:'app'},
      postcondition:rpc('artifact-v1'),
      realization:realization('artifact-v1'),
    });
    settleFile(f.kernel,'gate',gate,'ready');

    const before=f.kernel.inspect().find(work=>work.id==='build')!;
    assert.equal(before.status,'READY');
    assert.equal(before.run_id,undefined);

    const recorded=f.kernel.recordRealization(
      'build',
      {producer:{kind:'human',id:'builder'},content:'artifact-v1'},
      f.kernel.head()!,
    );
    const satisfied=f.kernel.inspect().find(work=>work.id==='build')!;
    assert.equal(satisfied.status,'DONE');
    assert.equal(satisfied.run_id,undefined);
    assert.equal(satisfied.realization_identity,recorded.fact.realization_identity);

    f.kernel.amend({
      id:'build',
      packet:{target:'app'},
      dependencies:[{kind:'control',upstream:'gate'}],
      postcondition:rpc('artifact-v1'),
      realization:realization('artifact-v1'),
    },f.kernel.head()!);

    const reused=f.kernel.inspect().find(work=>work.id==='build')!;
    assert.equal(reused.status,'DONE');
    assert.equal(reused.run_id,undefined);
    assert.equal(reused.realization_identity,recorded.fact.realization_identity);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('material realization input change removes reuse',()=>{
  const f=fixture();
  try {
    const artifact=f.path('artifact');
    f.kernel.define({
      id:'build',
      packet:{target:'app'},
      postcondition:rpc('artifact-v1'),
      realization:realization('artifact-v1','source-v1'),
    });
    f.kernel.recordRealization(
      'build',
      {producer:{kind:'agent',id:'agent-1'},content:'artifact-v1'},
      f.kernel.head()!,
    );
    assert.equal(f.kernel.inspect()[0].status,'DONE');

    f.kernel.amend({
      id:'build',
      packet:{target:'app'},
      postcondition:rpc('artifact-v1'),
      realization:realization('artifact-v1','source-v2'),
    },f.kernel.head()!);

    const current=f.kernel.inspect()[0];
    assert.equal(current.status,'READY');
    assert.equal(current.realization_identity,undefined);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('historical DONE receipt cannot satisfy a new obligation definition even when the old obligation key is unchanged',()=>{
  const f=fixture();
  try {
    const a=f.path('a');
    const c=f.path('c');
    const effect=f.path('effect');
    f.kernel.define({id:'a',postcondition:pc(a,'A')});
    f.kernel.define({id:'c',postcondition:pc(c,'C')});
    f.kernel.define({
      id:'publish',
      dependencies:[{kind:'control',upstream:'a'}],
      packet:{value:'same'},
      postcondition:pc(effect,'published'),
    });

    settleFile(f.kernel,'a',a,'A');
    settleFile(f.kernel,'c',c,'C');
    const historical=settleFile(f.kernel,'publish',effect,'published');
    assert.equal(f.kernel.inspect().find(work=>work.id==='publish')?.status,'DONE');

    f.kernel.amend({
      id:'publish',
      dependencies:[{kind:'control',upstream:'c'}],
      packet:{value:'same'},
      postcondition:pc(effect,'published'),
    },f.kernel.head()!);

    const current=f.kernel.inspect().find(work=>work.id==='publish')!;
    assert.equal(current.status,'READY');
    assert.equal(current.run_id,undefined);
    assert.equal(
      f.kernel.receipts(historical.run.id).at(-1)?.disposition,
      'DONE',
      'receipt remains factual execution history',
    );
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('known external effects cannot opt into reusable realization semantics',()=>{
  const f=fixture();
  try {
    const before=f.kernel.head();
    assert.throws(()=>f.kernel.define({
      id:'status',
      packet:{},
      postcondition:{
        verifier:'github-commit-status/v2',
        provider:'github',
        repository_id:42,
        repository_full_name:'acme/widget',
        commit_sha:'a'.repeat(40),
        context:'overcenter/proof',
        expected_state:'success',
      },
      realization:realization('success'),
    }),/REUSABLE_REALIZATION_FOR_EXTERNAL_EFFECT:status/);
    assert.equal(f.kernel.head(),before);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('realization-backed DONE reconstructs from a fresh authority checkout with no cache or run',()=>{
  const f=fixture();
  try {
    const artifact=f.path('artifact');
    f.kernel.define({
      id:'build',
      packet:{target:'app'},
      postcondition:rpc('artifact-v1'),
      realization:realization('artifact-v1'),
    });
    const recorded=f.kernel.recordRealization(
      'build',
      {producer:{kind:'previous-run',id:'run-old'},content:'artifact-v1'},
      f.kernel.head()!,
    );
    const before=f.kernel.inspect();
    assert.equal(before[0].status,'DONE');
    assert.equal(before[0].run_id,undefined);

    const clone=join(f.root,'fresh.git');
    execFileSync('git',['init','--bare',clone],{stdio:'ignore'});
    execFileSync('git',['-C',clone,'remote','add','origin',f.repo]);
    execFileSync(
      'git',
      ['-C',clone,'fetch','--no-tags','origin',`+${STATE_REF}:${STATE_REF}`],
      {stdio:'ignore'},
    );
    const fresh=new GitOvercenterKernel(clone);
    const after=fresh.inspect();

    assert.deepEqual(after,before);
    assert.equal(after[0].realization_identity,recorded.fact.realization_identity);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});
