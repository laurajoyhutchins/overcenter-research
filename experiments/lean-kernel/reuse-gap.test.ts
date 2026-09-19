import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

test('runtime current projection rejects historical DONE after mutable external drift',()=>{
  const root=mkdtempSync(join(tmpdir(),'overcenter-lean-reuse-gap-'));
  const repo=join(root,'authority.git');
  const external=join(root,'mutable.txt');
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});

  try {
    const kernel=new GitOvercenterKernel(repo);
    kernel.initialize();
    kernel.define({
      id:'mutable-file',
      postcondition:{
        verifier:'file-content-equals/v1',
        path:external,
        content:'A',
      },
    });

    const ready=kernel.deriveReadyWork();
    assert.ok(ready);
    const permit=kernel.claim(ready.id,ready.revision);

    kernel.beginEffect(permit);
    writeFileSync(external,'A');
    const settled=kernel.resolve(permit);
    assert.equal(settled.disposition,'DONE');

    // Hostile external drift after the durable DONE receipt.
    writeFileSync(external,'B');

    // Durable history still records that this run once settled DONE, but the
    // runtime current-realization overlay re-observes mutable external reality.
    const fresh=new GitOvercenterKernel(repo);
    const projected=fresh.inspect().find(work=>work.id==='mutable-file');
    assert.equal(projected?.status,'RECOVERY_REQUIRED');
    assert.equal(projected?.source_run_id,permit.id);
    assert.equal(projected?.run_id,undefined);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
