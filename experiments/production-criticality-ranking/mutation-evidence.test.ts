import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MUTATION_EVIDENCE_SCHEMA,
  mutationEvidenceSources,
  reconcileMutationEvidence,
} from './mutation-evidence.ts';

const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const source=(run,revision,artifact='sha256:'+'a'.repeat(64))=>({
  revision,
  workflow_run_id:run,
  artifact_digest:artifact,
  mutation_report_sha256:'sha256:'+'b'.repeat(64),
});

test('reconciles fresh targeted evidence without rewriting unrelated probe provenance',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-reconcile-'));
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src/a.ts'),'a\n');
  fs.writeFileSync(path.join(root,'src/b.ts'),'b\n');
  git(root,['init','-q']);
  git(root,['config','user.email','test@example.com']);
  git(root,['config','user.name','Test']);
  git(root,['add','.']);
  git(root,['commit','-qm','fixture']);
  const revision=git(root,['rev-parse','HEAD']);
  const blobA=git(root,['hash-object','src/a.ts']);
  const blobB=git(root,['hash-object','src/b.ts']);

  const current={
    schema:MUTATION_EVIDENCE_SCHEMA,
    probes:[
      {id:'a',source_run:source(1,revision),source_blobs:{'src/a.ts':blobA},selectors:[],mutation_score:.5},
      {id:'b',source_run:source(2,revision,'sha256:'+'c'.repeat(64)),source_blobs:{'src/b.ts':blobB},selectors:[],mutation_score:.6},
    ],
  };
  const generated={
    schema:MUTATION_EVIDENCE_SCHEMA,
    probes:[{
      id:'a',
      source_run:{
        revision,
        workflow_run_id:3,
        mutation_report_sha256:'sha256:'+'d'.repeat(64),
      },
      source_blobs:{'src/a.ts':blobA},
      selectors:[],
      mutation_score:1,
    }],
  };
  const digest='sha256:'+'e'.repeat(64);
  const result=reconcileMutationEvidence({current,generated,artifactDigest:digest,root});

  assert.deepEqual(result.updated,['a']);
  assert.deepEqual(result.skipped,[]);
  assert.equal(result.snapshot.probes[0].mutation_score,1);
  assert.equal(result.snapshot.probes[0].source_run.workflow_run_id,3);
  assert.equal(result.snapshot.probes[0].source_run.artifact_digest,digest);
  assert.deepEqual(result.snapshot.probes[1],current.probes[1]);

  assert.throws(
    ()=>reconcileMutationEvidence({
      current,
      generated,
      artifactDigest:digest,
      expectedWorkflowRunId:99,
      expectedRevision:revision,
      root,
    }),
    /expected 99/,
  );
});

test('skips a targeted result when its exact source blob is no longer current',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-reconcile-stale-'));
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src/a.ts'),'old\n');
  git(root,['init','-q']);
  git(root,['config','user.email','test@example.com']);
  git(root,['config','user.name','Test']);
  git(root,['add','.']);
  git(root,['commit','-qm','fixture']);
  const revision=git(root,['rev-parse','HEAD']);
  const oldBlob=git(root,['hash-object','src/a.ts']);
  const current={
    schema:MUTATION_EVIDENCE_SCHEMA,
    probes:[{id:'a',source_run:source(1,revision),source_blobs:{'src/a.ts':oldBlob},selectors:[],mutation_score:.5}],
  };
  const generated={
    schema:MUTATION_EVIDENCE_SCHEMA,
    probes:[{
      id:'a',
      source_run:{revision,workflow_run_id:2,mutation_report_sha256:'sha256:'+'d'.repeat(64)},
      source_blobs:{'src/a.ts':oldBlob},
      selectors:[],
      mutation_score:1,
    }],
  };
  fs.writeFileSync(path.join(root,'src/a.ts'),'new\n');

  const result=reconcileMutationEvidence({
    current,
    generated,
    artifactDigest:'sha256:'+'e'.repeat(64),
    root,
  });
  assert.deepEqual(result.updated,[]);
  assert.deepEqual(result.skipped,[{id:'a',files:['src/a.ts']}]);
  assert.deepEqual(result.snapshot,current);
});

test('groups per-probe provenance by exact workflow run',()=>{
  const revision='1'.repeat(40);
  const a=source(2,revision);
  const b=source(1,revision,'sha256:'+'c'.repeat(64));
  assert.deepEqual(
    mutationEvidenceSources({
      schema:MUTATION_EVIDENCE_SCHEMA,
      probes:[
        {id:'a',source_run:a},
        {id:'b',source_run:b},
        {id:'c',source_run:a},
      ],
    }),
    [b,a],
  );
});
