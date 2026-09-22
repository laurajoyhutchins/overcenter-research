import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const root=new URL('.',import.meta.url);
const corpus=JSON.parse(readFileSync(new URL('corpus.json',root),'utf8'));
test('Pylint holdout selection and gates are frozen',()=>{
  assert.equal(corpus.schema,'overcenter-code-graph-holdout-corpus/v1');
  assert.equal(corpus.cases.length,10);
  assert.deepEqual(corpus.cases.map(c=>c.id),["pylint-dev__pylint-4551","pylint-dev__pylint-4604","pylint-dev__pylint-4661","pylint-dev__pylint-4970","pylint-dev__pylint-6386","pylint-dev__pylint-6528","pylint-dev__pylint-6903","pylint-dev__pylint-7080","pylint-dev__pylint-7277","pylint-dev__pylint-8898"]);
  assert.deepEqual(corpus.primary_thresholds,{recall_min:0.99,selected_fraction_max:0.30,missed_regressions_max:0});
  assert.deepEqual(corpus.representation.source_roots,['pylint']);
  assert.deepEqual(corpus.representation.test_roots,['tests']);
  assert.equal(corpus.representation.frozen_before_holdout_outcomes,true);
  let human=0,ai=0;
  for(const c of corpus.cases){
    assert.match(c.base_commit,/^[0-9a-f]{40}$/);
    assert.equal(c.variants.length,2);
    const testPatch=readFileSync(new URL(c.test_patch,root),'utf8');
    assert.match(testPatch,/^diff --git /);
    for(const v of c.variants){
      assert.equal('evaluation' in v,false);
      const bytes=readFileSync(new URL(v.patch,root),'utf8');
      assert.match(bytes,/^diff --git /);
      const touched=[...bytes.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m=>m[1]);
      assert.ok(touched.every(p=>!p.startsWith('tests/')),v.patch);
      if(v.authorship==='human') human++;
      else if(v.authorship==='ai'){
        ai++;
        assert.equal(v.id,'ai-agentless-0');
        assert.match(v.provenance.source,/dedup_patch_0\.jsonl$/);
        assert.match(v.provenance.selection_rule,/no outcome metadata consulted/);
      }
    }
  }
  assert.equal(human,10); assert.equal(ai,10);
});
test('graph and scorer blobs are pinned',()=>{
  for(const [path,sha] of [[corpus.representation.frontier_path,corpus.representation.frontier_git_blob_sha],[corpus.representation.score_path,corpus.representation.score_git_blob_sha]]){
    const r=spawnSync('git',['hash-object',path],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr); assert.equal(r.stdout.trim(),sha,path);
  }
});
test('holdout scripts parse',()=>{
  for(const name of ['preflight.py','run_case.py','summarize.py']){
    const r=spawnSync('python3',[new URL(name,root).pathname,'--help'],{encoding:'utf8'});
    assert.equal(r.status,0,name+': '+(r.stderr||r.stdout));
  }
});
