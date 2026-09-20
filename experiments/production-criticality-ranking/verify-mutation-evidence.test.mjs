import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyMutationEvidence} from './verify-mutation-evidence.mjs';

const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();

test('binds committed mutation evidence to the authoritative artifact and current source bytes',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-evidence-'));
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src/core.ts'),'export const value=1;\n');
  git(root,['init','-q']);
  const blob=git(root,['hash-object','src/core.ts']);
  const source_run={
    revision:'a'.repeat(40),
    workflow_run_id:123,
    mutation_report_sha256:'sha256:'+'b'.repeat(64),
  };
  const probe={
    id:'core',
    source_blobs:{'src/core.ts':blob},
    selectors:[{file:'src/core.ts',name:'value'}],
    total:1,
    killed:1,
    survived:0,
    no_coverage:0,
    timeout_or_error:0,
    mutation_score:1,
  };
  const authoritative={schema:'overcenter-criticality-mutation-evidence/v1',source_run,probes:[probe]};
  const committed=structuredClone(authoritative);

  assert.deepEqual(
    verifyMutationEvidence({root,committed,authoritative}),
    {workflowRunId:123,revision:'a'.repeat(40),probes:1},
  );

  const forged=structuredClone(committed);
  forged.probes[0].mutation_score=0;
  assert.throws(
    ()=>verifyMutationEvidence({root,committed:forged,authoritative}),
    /does not match the authoritative workflow artifact/,
  );

  fs.writeFileSync(path.join(root,'src/core.ts'),'export const value=2;\n');
  assert.throws(
    ()=>verifyMutationEvidence({root,committed,authoritative}),
    /stale for current source/,
  );
});
