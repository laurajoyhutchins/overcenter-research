import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {analyze} from './analyze.ts';

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
    graphQuality:{minimumResolution:{production:0,test:0,experiment:0},failOnCriticalUnresolved:true},
    authorityClasses:[{id:'settlement',sink:{file:'src/core.ts',name:'settle'},recoveryClass:5}],
    recoveryScenarios:[{id:'recover-settle',entry:{file:'src/core.ts',name:'recover'},terminal:{file:'src/core.ts',name:'settle'}}],
    requiredCalibrationPairs:[{id:'settle-over-low',higher:{file:'src/core.ts',name:'settle'},lower:{file:'src/core.ts',name:'low'}}],
    diagnosticCalibrationPairs:[{id:'known-callable-gap',higher:{file:'src/core.ts',name:'low'},lower:{file:'src/core.ts',name:'settle'}}],
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
  assert.ok(settle.vector.C>0,'git blame recency must be parsed rather than silently collapsing to zero');
  assert.equal(helper.vector.A,1,'helper should inherit authority from the settlement path');
  assert.equal(settle.vector.E,1,'missing hostile-case evidence is itself an evidence obligation');
  assert.equal(settle.evidence.mutation.status,'missing');
  assert.equal(low.vector.E,1);
  assert.equal(r.calibration.required.failed,0);
  assert.equal(r.calibration.diagnostic.failed,1,'known model disagreement remains diagnostic rather than consuming a percentage budget');
  assert.ok(settle.consequenceScore>low.consequenceScore);
  assert.ok(Number.isFinite(settle.attentionScore));
  assert.ok(settle.consequenceRank<low.consequenceRank);
  assert.equal(inert.consequenceScore,0,'isolated unexported code has no measured consequence in the fixture');
  assert.equal(inert.attentionScore,0,'evidence gap and churn cannot create attention without consequence');

  const sourceBlob=git(root,['hash-object','src/core.ts']);
  write(root,'mutation-evidence.json',JSON.stringify({
    schema:'overcenter-criticality-mutation-evidence',
    probes:[{
      id:'settlement-hostile-cases',
      source_run:{revision:git(root,['rev-parse','HEAD']),workflow_run_id:123,artifact_digest:'sha256:'+'b'.repeat(64),mutation_report_sha256:'sha256:'+'a'.repeat(64)},
      source_blobs:{'src/core.ts':sourceBlob},
      selectors:[{file:'src/core.ts',name:'settle'}],
      mutation_score:.25,
    }],
  }));
  const evidenced=analyze({root,config:{...config,mutationEvidenceFile:'mutation-evidence.json'}});
  const evidencedSettle=evidenced.ranking.find(x=>x.name==='settle');
  assert.equal(evidencedSettle.vector.E,.75,'surviving mutants increase the evidence gap beyond reachability');
  assert.equal(evidencedSettle.evidence.mutation.status,'applied');
  assert.equal(evidencedSettle.consequenceScore,settle.consequenceScore,'evidence quality cannot change consequence criticality');
  assert.ok(evidencedSettle.attentionScore<settle.attentionScore,'better evidence can reduce attention priority');

  write(root,'mutation-evidence.json',JSON.stringify({
    schema:'overcenter-criticality-mutation-evidence',
    probes:[{
      id:'invalid-provenance',
      source_run:{revision:git(root,['rev-parse','HEAD'])},
    }],
  }));
  assert.throws(
    ()=>analyze({root,config:{...config,mutationEvidenceFile:'mutation-evidence.json'}}),
    /trusted-run provenance/,
    'checked-in mutation evidence without run provenance must not be accepted',
  );

  write(root,'mutation-evidence.json',JSON.stringify({
    schema:'overcenter-criticality-mutation-evidence',
    probes:[{
      id:'settlement-hostile-cases',
      source_run:{revision:git(root,['rev-parse','HEAD']),workflow_run_id:123,artifact_digest:'sha256:'+'b'.repeat(64),mutation_report_sha256:'sha256:'+'a'.repeat(64)},
      source_blobs:{'src/core.ts':'0000000000000000000000000000000000000000'},
      selectors:[{file:'src/core.ts',name:'settle'}],
      mutation_score:1,
    }],
  }));
  const stale=analyze({root,config:{...config,mutationEvidenceFile:'mutation-evidence.json'}});
  const staleSettle=stale.ranking.find(x=>x.name==='settle');
  assert.equal(staleSettle.vector.E,1,'stale mutation evidence fails closed');
  assert.equal(staleSettle.evidence.mutation.status,'stale');
});


test('disconnected production components cannot perturb existing consequence scores',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-component-invariance-'));
  write(root,'src/core.ts',`export function settle(){ return helper(); }\nfunction helper(){ return 1; }\nexport function recover(){ return settle(); }\nexport function low(){ return 0; }\n`);
  write(root,'test/core.test.ts',`import {settle} from '../src/core.ts';\nexport function regression(){ return settle(); }\n`);
  git(root,['init','-q']);git(root,['config','user.email','test@example.com']);git(root,['config','user.name','Test']);git(root,['add','.']);git(root,['commit','-qm','baseline'],{'GIT_AUTHOR_DATE':'2026-09-01T00:00:00Z','GIT_COMMITTER_DATE':'2026-09-01T00:00:00Z'});
  const config={
    requiredEvidenceTiers:['test'],
    graphQuality:{minimumResolution:{production:0,test:0},failOnCriticalUnresolved:true},
    authorityClasses:[{id:'settlement',sink:{file:'src/core.ts',name:'settle'},recoveryClass:5}],
    recoveryScenarios:[{id:'recover-settle',entry:{file:'src/core.ts',name:'recover'},terminal:{file:'src/core.ts',name:'settle'}}],
    requiredCalibrationPairs:[{id:'settle-over-low',higher:{file:'src/core.ts',name:'settle'},lower:{file:'src/core.ts',name:'low'}}],
    diagnosticCalibrationPairs:[],
  };
  const before=analyze({root,config});
  const beforeByName=new Map(
    before.ranking
      .filter(unit=>unit.file==='src/core.ts')
      .map(unit=>[unit.qualifiedName,{score:unit.consequenceScore,B:unit.vector.B,F:unit.vector.F,X:unit.vector.X}]),
  );

  write(root,'src/unrelated.ts',`export function unrelated(){ return leaf(); }\nfunction leaf(){ return 1; }\n`);
  git(root,['add','.']);
  git(root,['commit','-qm','disconnected provider'],{'GIT_AUTHOR_DATE':'2026-09-02T00:00:00Z','GIT_COMMITTER_DATE':'2026-09-02T00:00:00Z'});
  const after=analyze({root,config});
  const afterByName=new Map(
    after.ranking
      .filter(unit=>unit.file==='src/core.ts')
      .map(unit=>[unit.qualifiedName,{score:unit.consequenceScore,B:unit.vector.B,F:unit.vector.F,X:unit.vector.X}]),
  );

  assert.deepEqual(afterByName,beforeByName);
  assert.equal(before.calibration.required.failed,0);
  assert.equal(after.calibration.required.failed,0);
});


test('fails closed when the static graph becomes blind at critical callables or below configured floors',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-graph-'));
  write(root,'src/core.ts',`export function settle(){ const runtime:any={invoke:()=>1}; return runtime.invoke(); }\nexport function recover(){ return settle(); }\n`);
  git(root,['init','-q']);git(root,['config','user.email','test@example.com']);git(root,['config','user.name','Test']);git(root,['add','.']);git(root,['commit','-qm','fixture']);
  const base={
    requiredEvidenceTiers:[],
    authorityClasses:[{id:'settlement',sink:{file:'src/core.ts',name:'settle'},recoveryClass:5}],
    recoveryScenarios:[{id:'recover-settle',entry:{file:'src/core.ts',name:'recover'},terminal:{file:'src/core.ts',name:'settle'}}],
    requiredCalibrationPairs:[],
    diagnosticCalibrationPairs:[],
  };
  assert.throws(
    ()=>analyze({root,config:{...base,graphQuality:{minimumResolution:{production:0},failOnCriticalUnresolved:true}}}),
    /critical callable has unresolved callsite/,
  );
  assert.throws(
    ()=>analyze({root,config:{...base,graphQuality:{minimumResolution:{production:1},failOnCriticalUnresolved:false}}}),
    /graph resolution for production fell below floor/,
  );
});


test('does not treat typed Node or standard-library calls as production graph blindness',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-external-'));
  write(root,'src/core.ts',`import {createHash} from 'node:crypto';\nimport path from 'node:path';\nexport function settle(value='x'){ const clean=path.normalize(value); const bytes=Buffer.from(clean,'utf8'); return createHash('sha256').update(clean).digest('hex').length + bytes.toString('base64').length + Buffer.byteLength(clean,'utf8') + (clean.startsWith('.')?1:0); }\nexport function recover(){ return settle(); }\n`);
  git(root,['init','-q']);git(root,['config','user.email','test@example.com']);git(root,['config','user.name','Test']);git(root,['add','.']);git(root,['commit','-qm','fixture']);
  const config={
    requiredEvidenceTiers:[],
    graphQuality:{minimumResolution:{production:1},failOnCriticalUnresolved:true},
    authorityClasses:[{id:'settlement',sink:{file:'src/core.ts',name:'settle'},recoveryClass:5}],
    recoveryScenarios:[{id:'recover-settle',entry:{file:'src/core.ts',name:'recover'},terminal:{file:'src/core.ts',name:'settle'}}],
    requiredCalibrationPairs:[],
    diagnosticCalibrationPairs:[],
  };
  const r=analyze({root,config});
  assert.equal(r.analyzer.byScope.production.unknownCalls,0);
  assert.equal(r.analyzer.byScope.production.externalCalls,8);
  assert.equal(r.analyzer.byScope.production.internalResolutionRate,1);
});


test('expands interface dispatch to every assignable production implementation',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-polymorphic-'));
  write(root,'src/core.ts',`interface Store { append():number; }\nclass StoreA implements Store { append(){ return 1; } }\nclass StoreB implements Store { append(){ return 2; } }\nexport class Kernel { constructor(readonly store:Store){} claim(){ return this.store.append(); } recover(){ return this.claim(); } }\n`);
  git(root,['init','-q']);git(root,['config','user.email','test@example.com']);git(root,['config','user.name','Test']);git(root,['add','.']);git(root,['commit','-qm','fixture']);
  const config={
    requiredEvidenceTiers:[],
    graphQuality:{minimumResolution:{production:1},failOnCriticalUnresolved:true},
    authorityClasses:[{id:'claim',sink:{file:'src/core.ts',qualifiedName:'Kernel.claim'},recoveryClass:4}],
    recoveryScenarios:[{id:'recover-claim',entry:{file:'src/core.ts',qualifiedName:'Kernel.recover'},terminal:{file:'src/core.ts',qualifiedName:'Kernel.claim'}}],
    requiredCalibrationPairs:[],
    diagnosticCalibrationPairs:[],
  };
  const r=analyze({root,config});
  assert.equal(r.analyzer.byScope.production.resolvedPolymorphicCalls,1);
  assert.equal(r.analyzer.byScope.production.unresolvedInternalCalls,0);
  assert.equal(r.ranking.find(x=>x.qualifiedName==='StoreA.append').vector.A,1);
  assert.equal(r.ranking.find(x=>x.qualifiedName==='StoreB.append').vector.A,1);
});


test('recognizes runtime-global and external-value method calls as external boundaries',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-runtime-boundary-'));
  write(root,'src/core.ts',`import { posix as path } from 'node:path';\nexport function encode(value:string){ const bytes=Buffer.from(value); return bytes.toString('base64'); }\nexport function normalize(value:string){ const clean=path.normalize(value); return clean.startsWith('../'); }\n`);
  git(root,['init','-q']);git(root,['config','user.email','test@example.com']);git(root,['config','user.name','Test']);git(root,['add','.']);git(root,['commit','-qm','fixture']);
  const r=analyze({root,config:{
    requiredEvidenceTiers:[],
    graphQuality:{minimumResolution:{production:1},failOnCriticalUnresolved:true},
    authorityClasses:[],
    recoveryScenarios:[],
    requiredCalibrationPairs:[],
    diagnosticCalibrationPairs:[],
  }});
  assert.equal(r.analyzer.byScope.production.unknownCalls,0);
  assert.equal(r.analyzer.byScope.production.unresolvedInternalCalls,0);
  assert.equal(r.analyzer.byScope.production.internalResolutionRate,1);
  assert.ok(r.analyzer.byScope.production.externalCalls>=4);
});


test('treats noncritical injected callbacks as explicit dependency boundaries',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-callback-boundary-'));
  write(root,'src/core.ts',`export function scan(readPage:()=>number){ return readPage(); }\n`);
  git(root,['init','-q']);git(root,['config','user.email','test@example.com']);git(root,['config','user.name','Test']);git(root,['add','.']);git(root,['commit','-qm','fixture']);
  const r=analyze({root,config:{
    requiredEvidenceTiers:[],
    graphQuality:{minimumResolution:{production:1},failOnCriticalUnresolved:true},
    authorityClasses:[],
    recoveryScenarios:[],
    requiredCalibrationPairs:[],
    diagnosticCalibrationPairs:[],
  }});
  assert.equal(r.analyzer.byScope.production.externalCallbackCalls,1);
  assert.equal(r.analyzer.byScope.production.unknownCalls,0);
  assert.equal(r.analyzer.byScope.production.internalResolutionRate,1);
});


test('fails closed on unresolved parameter-bound callbacks in critical production callables',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-callback-'));
  write(root,'src/core.ts',`export function settle(callback:()=>number){ return callback(); }\nexport function recover(){ return settle(()=>1); }\n`);
  git(root,['init','-q']);git(root,['config','user.email','test@example.com']);git(root,['config','user.name','Test']);git(root,['add','.']);git(root,['commit','-qm','fixture']);
  const base={
    requiredEvidenceTiers:[],
    authorityClasses:[{id:'settlement',sink:{file:'src/core.ts',name:'settle'},recoveryClass:5}],
    recoveryScenarios:[{id:'recover-settle',entry:{file:'src/core.ts',name:'recover'},terminal:{file:'src/core.ts',name:'settle'}}],
    requiredCalibrationPairs:[],
    diagnosticCalibrationPairs:[],
  };
  assert.throws(
    ()=>analyze({root,config:{...base,graphQuality:{minimumResolution:{production:0},failOnCriticalUnresolved:true}}}),
    /critical callable has unresolved callsite/,
    'critical callback dispatch must not be inferred external merely because it is parameter-bound',
  );
  assert.throws(
    ()=>analyze({root,config:{...base,graphQuality:{minimumResolution:{production:1},failOnCriticalUnresolved:false}}}),
    /graph resolution for production fell below floor/,
    'parameter callback dispatch must count against the production resolution floor',
  );

  const declared=analyze({root,config:{...base,graphQuality:{
    minimumResolution:{production:1},
    failOnCriticalUnresolved:true,
    criticalCallbackBoundaries:[{
      caller:{file:'src/core.ts',name:'settle'},
      parameter:'callback',
      rationale:'test boundary',
    }],
  }}});
  assert.equal(declared.analyzer.byScope.production.externalCallbackCalls,1);
  assert.equal(declared.analyzer.byScope.production.unknownCalls,0);
  assert.deepEqual(
    declared.analyzer.criticalCallbackBoundaries.map(({parameter,rationale})=>({parameter,rationale})),
    [{parameter:'callback',rationale:'test boundary'}],
  );

  assert.throws(
    ()=>analyze({root,config:{...base,graphQuality:{
      minimumResolution:{production:1},
      failOnCriticalUnresolved:true,
      criticalCallbackBoundaries:[{
        caller:{file:'src/core.ts',name:'settle'},
        parameter:'renamed_callback',
      }],
    }}}),
    /critical callback boundary parameter renamed_callback is not declared/,
    'stale critical callback boundary declarations must fail closed',
  );
});
