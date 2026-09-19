import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

test('gap witness: historical DONE currently survives mutable external file drift',()=>{
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

    // Fresh reconstruction uses only durable history. Today it does not
    // re-observe mutable external reality before projecting DONE.
    const fresh=new GitOvercenterKernel(repo);
    const projected=fresh.inspect().find(work=>work.id==='mutable-file');
    assert.equal(projected?.status,'DONE');

    // This is intentionally a gap witness, not desired behavior. The Lean
    // theorem mutable_external_without_fresh_observation_never_reuses proves
    // that the target semantics reject this historical reuse.
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
