import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const root=new URL('.',import.meta.url);
const corpus=JSON.parse(readFileSync(new URL('corpus.json',root),'utf8'));

test('Requests holdout is frozen before outcomes',()=>{
  assert.equal(corpus.schema,'overcenter-code-graph-holdout-corpus/v1');
  assert.equal(corpus.subject.repository,'psf/requests');
  assert.equal(corpus.cases.length,8);
  assert.deepEqual(corpus.cases.map(c=>c.id),[
    'psf__requests-1142','psf__requests-1724','psf__requests-1766','psf__requests-1921',
    'psf__requests-2317','psf__requests-2931','psf__requests-5414','psf__requests-6028'
  ]);
  assert.equal(corpus.primary_thresholds.recall_min,0.99);
  assert.equal(corpus.primary_thresholds.selected_fraction_max,0.30);
  assert.equal(corpus.primary_thresholds.missed_regressions_max,0);
  assert.equal(corpus.representation.frozen_before_holdout_outcomes,true);
  assert.equal(corpus.representation.bounded_attribute_candidate_limit,3);

  let human=0,ai=0;
  for(const c of corpus.cases){
    assert.match(c.base_commit,/^[0-9a-f]{40}$/);
    assert.equal(c.variants.length,2);
    for(const v of c.variants){
      const bytes=readFileSync(new URL(v.patch,root),'utf8');
      assert.ok(bytes.startsWith('diff --git '),v.patch);
      assert.equal('evaluation' in v,false,'holdout must not carry outcome metadata');
      if(v.authorship==='human') human++;
      if(v.authorship==='ai'){
        ai++;
        assert.equal(v.id,'ai-agentless-0');
        assert.match(v.provenance.source,/dedup_patch_0\.jsonl$/);
        assert.match(v.provenance.selection_rule,/no outcome metadata consulted/);
      }
    }
  }
  assert.equal(human,8);
  assert.equal(ai,8);
});

test('graph and scorer identities are pinned',()=>{
  for(const [path,expected] of [
    [corpus.representation.frontier_path,corpus.representation.frontier_git_blob_sha],
    [corpus.representation.score_path,corpus.representation.score_git_blob_sha]
  ]){
    const r=spawnSync('git',['hash-object',path],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    assert.equal(r.stdout.trim(),expected,path);
  }
});

test('holdout scripts parse without side effects',()=>{
  for(const name of ['preflight.py','run_case.py','summarize.py']){
    const r=spawnSync('python3',[new URL(name,root).pathname,'--help'],{encoding:'utf8'});
    assert.equal(r.status,0,name+': '+(r.stderr||r.stdout));
  }
});
