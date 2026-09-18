import assert from 'node:assert/strict';
import test from 'node:test';
import { RECEIPT_SCHEMA, type ReceiptFact } from '../src/facts.ts';
import type { GitHubCommitStatusPostcondition, Obligation } from '../src/model.ts';
import { observePostcondition } from '../src/observation.ts';
import {
  observeCertifiedGithubCommitStatus,
} from '../src/providers/github-certified-status.ts';
import { GITHUB_OPENAPI_SHA256 } from '../src/providers/github-contract.ts';
import type { GithubJsonGet } from '../src/providers/github-status.ts';
import { projectReceipt } from '../src/projection.ts';

const COMMIT='a'.repeat(40);

function postcondition(context='overcenter/proof'):GitHubCommitStatusPostcondition {
  return {
    verifier:'github-commit-status/v1',
    provider:'github',
    repository_id:42,
    commit_sha:COMMIT,
    context,
    expected_state:'success',
  };
}

function status(id:number,context:string,state:'error'|'failure'|'pending'|'success'='success') {
  return {
    id,
    node_id:`STATUS_${id}`,
    state,
    context,
    target_url:null,
    created_at:'2026-09-18T16:00:00Z',
    updated_at:'2026-09-18T16:01:00Z',
  };
}

function provider(pages:unknown[][]):{get:GithubJsonGet;calls:string[]} {
  const calls:string[]=[];
  const get:GithubJsonGet=(_token,path)=>{
    calls.push(path);
    if (path==='/repositories/42') {
      return {id:42,full_name:'acme/widget'};
    }
    if (path==='/repos/acme/widget') {
      return {
        id:42,
        node_id:'R_42',
        full_name:'acme/widget',
        name:'widget',
        owner:{login:'acme'},
      };
    }
    const match=/[?&]page=(\d+)/.exec(path);
    if (!match) throw new Error(`unexpected provider path: ${path}`);
    return pages[Number(match[1])-1]??[];
  };
  return {get,calls};
}

function receiptFor(observed:ReturnType<typeof observePostcondition>):ReturnType<typeof projectReceipt> {
  const work:Obligation={
    id:'status-proof',
    dependencies:[],
    packet:{},
    postcondition:postcondition(),
  };
  const fact:ReceiptFact={
    schema:RECEIPT_SCHEMA,
    run_id:'run-1',
    obligation_id:work.id,
    claimed_revision:'b'.repeat(40),
    claim_commit:'c'.repeat(40),
    kind:'observation',
    observed,
    settled_at:'2026-09-18T16:02:00Z',
  };
  return projectReceipt(fact,work);
}

test('certified GitHub status membership preserves positive settlement evidence', () => {
  const p=provider([[status(1,'Overcenter/Proof')]]);
  const observed=observePostcondition(postcondition(),{
    githubToken:'token',
    githubGet:p.get,
    clock:()=> '2026-09-18T16:02:00.000Z',
  });

  assert.equal(observed.mutation_certainty,'present');
  assert.equal(observed.actual_state,'success');
  assert.deepEqual(observed.legacy_interpretation,{mutation_certainty:'present'});

  const evidence=observed.provider_evidence as Record<string,unknown>;
  assert.equal(evidence.schema_sha256,GITHUB_OPENAPI_SHA256);
  assert.equal(evidence.operation_id,'repos/list-commit-statuses-for-ref');
  assert.equal((evidence.pages as Array<Record<string,unknown>>).length,1);
  assert.equal(receiptFor(observed).disposition,'DONE');
});

test('missing commit status is indeterminate even though the legacy interpretation was absent', () => {
  const p=provider([[]]);
  const observed=observePostcondition(postcondition(),{
    githubToken:'token',
    githubGet:p.get,
    clock:()=> '2026-09-18T16:03:00.000Z',
  });

  assert.equal(observed.mutation_certainty,'uncertain');
  assert.equal(observed.negative_evidence_authoritative,false);
  assert.equal(observed.observation_error,'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');
  assert.deepEqual(observed.legacy_interpretation,{mutation_certainty:'absent'});
  assert.equal(receiptFor(observed).disposition,'RECOVERY_REQUIRED');
});

test('certified status scan can prove membership on a later page without upgrading absence', () => {
  const first=Array.from({length:100},(_,index)=>status(index+1,`other/${index}`));
  const p=provider([first,[status(101,'overcenter/proof')]]);
  const result=observeCertifiedGithubCommitStatus('token',{
    repositoryId:42,
    commitSha:COMMIT,
    context:'overcenter/proof',
    get:p.get,
    clock:()=> '2026-09-18T16:04:00.000Z',
  });

  assert.equal(result.state,'present');
  assert.equal(result.actual_state,'success');
  assert.equal(result.evidence.pages.length,2);
  assert.equal(result.evidence.pages[0].member_count,100);
  assert.equal(result.evidence.pages[1].member_count,1);
});

test('malformed provider response fails closed before it becomes GitHub truth', () => {
  const malformed=[{
    id:1,
    state:'success',
    context:'overcenter/proof',
    target_url:null,
    created_at:'2026-09-18T16:00:00Z',
    updated_at:'2026-09-18T16:01:00Z',
  }];
  const p=provider([malformed]);
  const observed=observePostcondition(postcondition(),{
    githubToken:'token',
    githubGet:p.get,
    clock:()=> '2026-09-18T16:05:00.000Z',
  });

  assert.equal(observed.mutation_certainty,'uncertain');
  assert.match(String(observed.observation_error),/RESPONSE_SLICE_REQUIRED_FIELD_MISSING:\[\]\.node_id/);
  assert.equal(observed.provider_evidence,undefined);
  assert.equal(receiptFor(observed).disposition,'RECOVERY_REQUIRED');
});
