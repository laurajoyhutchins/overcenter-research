import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyMutationEvidence} from './verify-mutation-evidence.mjs';

const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const sha256=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');

test('binds mutation claims to a successful artifact while reporting current staleness separately',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-evidence-'));
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.writeFileSync(path.join(root,'src/core.ts'),'export const value=1;\n');
  git(root,['init','-q']);
  git(root,['config','user.email','test@example.com']);
  git(root,['config','user.name','Test']);
  git(root,['add','.']);
  git(root,['commit','-qm','fixture']);

  const revision=git(root,['rev-parse','HEAD']);
  const blob=git(root,['rev-parse',`${revision}:src/core.ts`]);
  const report={
    files:{
      'src/core.ts':{
        mutants:[{
          id:'m1',
          status:'Killed',
          location:{start:{line:1,column:1},end:{line:1,column:2}},
        }],
      },
    },
  };
  const reportBytes=Buffer.from(JSON.stringify(report));
  const resolved={
    schema:'overcenter-criticality-resolved-mutation-probes/v1',
    probes:[{
      id:'core',
      ranges:[{file:'src/core.ts',name:'value',qualifiedName:'value',start:1,end:1}],
    }],
  };
  const committed={
    schema:'overcenter-criticality-mutation-evidence/v1',
    source_run:{
      revision,
      workflow_run_id:123,
      mutation_report_sha256:sha256(reportBytes),
    },
    probes:[{
      id:'core',
      source_blobs:{'src/core.ts':blob},
      selectors:[{file:'src/core.ts',name:'value'}],
      total:1,
      killed:1,
      survived:0,
      no_coverage:0,
      timeout_or_error:0,
      mutation_score:1,
    }],
  };

  assert.deepEqual(
    verifyMutationEvidence({root,committed,report,reportBytes,resolved}),
    {workflowRunId:123,revision,probes:1,stale:[]},
  );

  const forged=structuredClone(committed);
  forged.probes[0].mutation_score=0;
  assert.throws(
    ()=>verifyMutationEvidence({root,committed:forged,report,reportBytes,resolved}),
    /mutation claim mismatch/,
  );

  const wrongBlob=structuredClone(committed);
  wrongBlob.probes[0].source_blobs['src/core.ts']='0'.repeat(40);
  assert.throws(
    ()=>verifyMutationEvidence({root,committed:wrongBlob,report,reportBytes,resolved}),
    /historical source blob mismatch/,
  );

  fs.writeFileSync(path.join(root,'src/core.ts'),'export const value=2;\n');
  const stale=verifyMutationEvidence({root,committed,report,reportBytes,resolved});
  assert.deepEqual(stale.stale.map(item=>[item.probe,item.file]),[['core','src/core.ts']]);
});
