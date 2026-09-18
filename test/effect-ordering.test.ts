import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../src/git-kernel.ts';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'overcenter-effect-order-'));
  const repo=join(root,'state.git');
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(repo);
  kernel.initialize();
  return {root,repo,kernel,path:(name:string)=>join(root,name)};
}

function statusPostcondition(state:'success'|'failure') {
  return {
    verifier:'github-commit-status/v1' as const,
    provider:'github' as const,
    repository_id:123,
    commit_sha:'a'.repeat(40),
    context:'overcenter/conflict',
    expected_state:state,
  };
}

test('unordered incompatible intents on one canonical effect resource cannot be claimed', () => {
  const f=fixture();
  try {
    f.kernel.define({id:'alpha',postcondition:statusPostcondition('success')});
    f.kernel.define({id:'beta',postcondition:statusPostcondition('failure')});
    const ready=f.kernel.deriveReadyWork()!;
    assert.equal(ready.id,'alpha');
    assert.throws(
      ()=>f.kernel.claim(ready.id,ready.revision),
      /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
    );
    assert.deepEqual(
      f.kernel.inspect().map(work=>[work.id,work.status]),
      [['alpha','READY'],['beta','READY']],
    );
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('explicit dependency orders incompatible transitions on the same resource', () => {
  const f=fixture();
  try {
    const shared=f.path('shared');
    f.kernel.define({
      id:'alpha',
      postcondition:{verifier:'file-content-equals/v1',path:shared,content:'A'},
    });
    f.kernel.define({
      id:'beta',
      deps:['alpha'],
      postcondition:{verifier:'file-content-equals/v1',path:shared,content:'B'},
    });

    const alpha=f.kernel.deriveReadyWork()!;
    const runA=f.kernel.claim(alpha.id,alpha.revision);
    writeFileSync(shared,'A');
    assert.equal(f.kernel.resolve(runA.id).disposition,'DONE');

    const beta=f.kernel.deriveReadyWork()!;
    assert.equal(beta.id,'beta');
    const runB=f.kernel.claim(beta.id,beta.revision);
    writeFileSync(shared,'B');
    assert.equal(f.kernel.resolve(runB.id).disposition,'DONE');

    assert.deepEqual(
      f.kernel.inspect().map(work=>[work.id,work.status]),
      [['alpha','DONE'],['beta','DONE']],
    );
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('identical desired state does not create a false conflict', () => {
  const f=fixture();
  try {
    const shared=f.path('shared');
    const postcondition={verifier:'file-content-equals/v1' as const,path:shared,content:'same'};
    f.kernel.define({id:'alpha',postcondition});
    f.kernel.define({id:'beta',postcondition});

    const runA=f.kernel.claim('alpha',f.kernel.deriveReadyWork()!.revision);
    const beta=f.kernel.deriveReadyWork()!;
    assert.equal(beta.id,'beta');
    const runB=f.kernel.claim(beta.id,beta.revision);

    assert.notEqual(runA.id,runB.id);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});
