import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GitOvercenterKernel } from '../src/git-kernel.ts';
import { OvercenterKernel } from '../src/kernel.ts';
import { runLocalEffectLoopForTest } from './support/local-effect-loop.ts';
import type { KernelCore } from '../src/kernel-core.ts';

const OMIT=new Set([
  'revision',
  'run_id',
  'claimed_revision',
  'claim_commit',
  'execution_authority_commit',
  'execution_capability_sha256',
  'settlement_commit',
  'settled_at',
]);

function normalize(value:unknown):unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value==='object') {
    return Object.fromEntries(
      Object.entries(value as Record<string,unknown>)
        .filter(([key])=>!OMIT.has(key))
        .sort(([a],[b])=>a.localeCompare(b))
        .map(([key,item])=>[key,normalize(item)]),
    );
  }
  return value;
}

function snapshot(kernel:KernelCore) {
  const work=kernel.inspect();
  return normalize({
    work,
    explanations:work.map(item=>kernel.explain(item.id)),
    receipts:kernel.receipts(),
  });
}

async function exercise(
  kernel:KernelCore,
  run:(kernel:KernelCore,options:{
    effect:(packet:Record<string,unknown>)=>Promise<{kind:'ok'}>;
  })=>Promise<unknown>,
  firstPath:string,
  secondPath:string,
) {
  kernel.initialize();
  kernel.define({
    id:'first',
    packet:{path:firstPath,content:'A'},
    postcondition:{
      verifier:'file-content-equals/v1',
      path:firstPath,
      content:'A',
    },
  });
  kernel.define({
    id:'second',
    dependencies:[{kind:'control',upstream:'first'}],
    packet:{path:secondPath,content:'B'},
    postcondition:{
      verifier:'file-content-equals/v1',
      path:secondPath,
      content:'B',
    },
  });

  const before=snapshot(kernel);
  await run(kernel,{
    effect:async packet=>{
      writeFileSync(String(packet.path),String(packet.content));
      return {kind:'ok'};
    },
  });
  return {before,after:snapshot(kernel)};
}

test('Git and SQLite kernels derive the same logical project transitions',async()=>{
  const root=mkdtempSync(join(tmpdir(),'kernel-backend-differential-'));
  const repoPath=join(root,'authority.git');
  const database=join(root,'authority.sqlite');
  const firstPath=join(root,'first.txt');
  const secondPath=join(root,'second.txt');
  execFileSync('git',['init','--bare',repoPath],{stdio:'ignore'});

  const git=new GitOvercenterKernel(repoPath);
  const sqlite=new OvercenterKernel(database);

  try {
    const gitResult=await exercise(
      git,
      (kernel,options)=>runLocalEffectLoopForTest(
        kernel as GitOvercenterKernel,
        options,
      ),
      firstPath,
      secondPath,
    );

    unlinkSync(firstPath);
    unlinkSync(secondPath);

    const sqliteResult=await exercise(
      sqlite,
      runLocalEffectLoopForTest,
      firstPath,
      secondPath,
    );

    assert.deepEqual(sqliteResult.before,gitResult.before);
    assert.deepEqual(sqliteResult.after,gitResult.after);
  } finally {
    sqlite.close();
    rmSync(root,{recursive:true,force:true});
  }
});
