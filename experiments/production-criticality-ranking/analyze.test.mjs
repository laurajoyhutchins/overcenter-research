import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {analyze} from './analyze.mjs';

function write(root,p,content){const full=path.join(root,p);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,content);}
function git(root,args,env={}){return execFileSync('git',args,{cwd:root,encoding:'utf8',env:{...process.env,...env}}).trim();}

test('ranks only production callables and derives structural authority/evidence metrics',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-'));
  write(root,'src/core.ts',`export function settle(){ return helper(); }\nfunction helper(){ return 1; }\nexport function low(){ return 0; }\nexport function recover(){ return settle(); }\nfunction inert(){ return 0; }\n`);
  write(root,'test/core.test.ts',`import {settle} from '../src/core.ts';\nexport function regression(){ return settle(); }\n`);
  write(root,'experiments/demo/demo.test.ts',`import {settle} from '../../src/core.ts';\nexport function adversarial(){ return settle(); }\n`);
  git(root,['init','-q']);git(root,['config','user.email','test@example.com']);git(root,['config','user.name','Test']);git(root,['add','.']);git(root,['commit','-qm','fixture'],{'GIT_AUTHOR_DATE':'2026-09-01T00:00:00Z','GIT_COMMITTER_DATE':'2026-09-01T00:00:00Z'});
  const config={
    maxRecoveryClass:6,
    changeHalfLifeDays:30,
    requiredEvidenceTiers:['test','experiment'],
    authorityClasses:[{id:'settlement',sink:{file:'src/core.ts',name:'settle'},recoveryClass:5}],
    recoveryScenarios:[{id:'recover-settle',entry:{file:'src/core.ts',name:'recover'},terminal:{file:'src/core.ts',name:'settle'}}],
    calibrationPairs:[{id:'settle-over-low',higher:{file:'src/core.ts',name:'settle'},lower:{file:'src/core.ts',name:'low'}}],
  };
  const r=analyze({root,config});
  assert.equal(r.population.productionCallables,5);
  assert.equal(r.ranking.some(x=>x.file.startsWith('test/')),false);
  assert.equal(r.ranking.some(x=>x.file.startsWith('experiments/')),false);
  const settle=r.ranking.find(x=>x.name==='settle');
  const helper=r.ranking.find(x=>x.name==='helper');
  const low=r.ranking.find(x=>x.name==='low');
  const inert=r.ranking.find(x=>x.name==='inert');
  assert.equal(settle.vector.A,1);
  assert.equal(helper.vector.A,1,'helper should inherit authority from the settlement path');
  assert.equal(settle.vector.E,0,'test + experiment support closes the two-tier proxy gap');
  assert.equal(low.vector.E,1);
  assert.equal(r.calibration.agreement,1);
  assert.ok(settle.consequenceScore>low.consequenceScore);
  assert.ok(Number.isFinite(settle.attentionScore));
  assert.ok(settle.consequenceRank<low.consequenceRank);
  assert.equal(inert.consequenceScore,0,'isolated unexported code has no measured consequence in the fixture');
  assert.equal(inert.attentionScore,0,'evidence gap and churn cannot create attention without consequence');
});
