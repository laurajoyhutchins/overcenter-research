import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../src/git-kernel.ts';

test('kernel can durably claim a wide ready frontier without batch-only state',()=>{
  const root=mkdtempSync(join(tmpdir(),'overcenter-frontier-'));
  const repo=join(root,'repo');
  execFileSync('git',['init',repo],{stdio:'ignore'});
  execFileSync('git',['-C',repo,'config','user.email','test@example.com']);
  execFileSync('git',['-C',repo,'config','user.name','Test']);
  const kernel=new GitOvercenterKernel(repo);
  try {
    kernel.initialize();
    for (const id of ['a','b','c','root']) {
      kernel.define({
        id,
        postcondition:{
          verifier:'file-content-equals/v1',
          path:`/provider/${id}`,
          content:id,
        },
      });
    }
    kernel.define({
      id:'downstream',
      dependencies:[{kind:'control',upstream:'root'}],
      postcondition:{
        verifier:'file-content-equals/v1',
        path:'/provider/downstream',
        content:'downstream',
      },
    });

    assert.deepEqual(
      kernel.deriveReadyFrontier().map(work=>work.id),
      ['a','b','c','root'],
    );

    const first=kernel.claimReadyFrontier(2);
    assert.equal(first.length,2);
    assert.deepEqual(first.map(permit=>permit.obligation_id),['a','b']);

    assert.deepEqual(
      kernel.deriveReadyFrontier().map(work=>work.id),
      ['c','root'],
    );

    const second=kernel.claimReadyFrontier();
    assert.deepEqual(second.map(permit=>permit.obligation_id),['c','root']);
    assert.equal(kernel.deriveReadyFrontier().length,0);

    const projected=new Map(kernel.inspect().map(work=>[work.id,work.status]));
    assert.equal(projected.get('a'),'EXECUTING');
    assert.equal(projected.get('b'),'EXECUTING');
    assert.equal(projected.get('c'),'EXECUTING');
    assert.equal(projected.get('root'),'EXECUTING');
    assert.equal(projected.get('downstream'),'BLOCKED');
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
