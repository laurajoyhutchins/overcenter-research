import assert from 'node:assert/strict';
import test from 'node:test';
import { RECEIPT_SCHEMA, type ReceiptFact } from '../src/authority/facts.ts';
import type { GitHubCommitStatusPostcondition, Obligation } from '../src/model.ts';
import { observePostcondition } from '../src/observation/observe.ts';
import {
  GITHUB_OPENAPI_SHA256,
  observeCertifiedGithubCommitStatus,
  type GithubJsonGet,
} from '../src/providers/github/certified-status.ts';
import { projectReceipt } from '../src/authority/replay.ts';
import { effectSemantics, verifiedContentIdentity } from '../src/semantics.ts';

const COMMIT='a'.repeat(40);

function postcondition(
  context='overcenter/proof',
  repositoryFullName='acme/widget',
):GitHubCommitStatusPostcondition {
  return {
    verifier:'github-commit-status/v2',
    provider:'github',
    repository_id:42,
    repository_full_name:repositoryFullName,
    commit_sha:COMMIT,
    context,
    expected_state:'success',
  };
}

function repository(overrides:Record<string,unknown>={}) {
  return {
    id:42,
    node_id:'R_42',
    full_name:'acme/widget',
    name:'widget',
    owner:{login:'acme'},
    ...overrides,
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

function provider(
  pages:unknown[][],
  repositoryBody:unknown=repository(),
):{get:GithubJsonGet;calls:string[]} {
  const calls:string[]=[];
  const get:GithubJsonGet=(_token,path)=>{
    calls.push(path);
    if (path==='/repos/acme/widget') return repositoryBody;
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

test('repository full name is a locator, not GitHub status effect identity', () => {
  const before=postcondition('overcenter/proof','acme/widget');
  const after=postcondition('overcenter/proof','renamed-acme/renamed-widget');

  assert.equal(verifiedContentIdentity(before),verifiedContentIdentity(after));
  assert.deepEqual(effectSemantics(before),effectSemantics(after));
});

test('certified repository identity and status membership preserve positive settlement evidence', () => {
  const p=provider([[status(1,'Overcenter/Proof')]]);
  const observed=observePostcondition(postcondition(),{
    githubToken:'token',
    githubGet:p.get,
    clock:()=> '2026-09-18T16:02:00.000Z',
  });

  assert.equal(observed.mutation_certainty,'present');
  assert.equal(observed.actual_state,'success');
  assert.equal(observed.repository_id,42);
  assert.equal(observed.repository_full_name,'acme/widget');

  const evidence=observed.provider_evidence as Record<string,unknown>;
  assert.equal(evidence.schema_sha256,GITHUB_OPENAPI_SHA256);
  assert.equal(evidence.status_operation_id,'repos/list-commit-statuses-for-ref');
  const repositoryEvidence=evidence.repository as Record<string,unknown>;
  assert.equal(repositoryEvidence.operation_id,'repos/get');
  assert.equal(repositoryEvidence.node_id,'R_42');
  assert.equal(repositoryEvidence.canonical_full_name,'acme/widget');
  assert.equal((evidence.pages as Array<Record<string,unknown>>).length,1);
  assert.equal(receiptFor(observed).disposition,'DONE');
  assert.deepEqual(p.calls.slice(0,2),[
    '/repos/acme/widget',
    `/repos/acme/widget/commits/${COMMIT}/statuses?page=1&per_page=30`,
  ]);
  assert.ok(!p.calls.some(path=>path.startsWith('/repositories/')));
});

test('missing commit status remains indeterminate after certified repository lookup', () => {
  const p=provider([[]]);
  const observed=observePostcondition(postcondition(),{
    githubToken:'token',
    githubGet:p.get,
    clock:()=> '2026-09-18T16:03:00.000Z',
  });

  assert.equal(observed.mutation_certainty,'uncertain');
  assert.equal(observed.absence_evidence,undefined);
  assert.equal(observed.observation_error,'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');
  assert.equal(receiptFor(observed).disposition,'RECOVERY_REQUIRED');
});

test('repository locator cannot override stable repository identity', () => {
  const p=provider([[status(1,'overcenter/proof')]],repository({id:43}));
  const observed=observePostcondition(postcondition(),{
    githubToken:'token',
    githubGet:p.get,
    clock:()=> '2026-09-18T16:03:30.000Z',
  });

  assert.equal(observed.mutation_certainty,'uncertain');
  assert.equal(observed.observation_error,'GITHUB_REPOSITORY_IDENTITY_MISMATCH');
  assert.equal(observed.provider_evidence,undefined);
  assert.deepEqual(p.calls,['/repos/acme/widget']);
  assert.equal(receiptFor(observed).disposition,'RECOVERY_REQUIRED');
});

test('certified status scan can prove membership on a later page without upgrading absence', () => {
  const first=Array.from({length:30},(_,index)=>status(index+1,`other/${index}`));
  const p=provider([first,[status(31,'overcenter/proof')]]);
  const result=observeCertifiedGithubCommitStatus('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    commitSha:COMMIT,
    context:'overcenter/proof',
    get:p.get,
    clock:()=> '2026-09-18T16:04:00.000Z',
  });

  assert.equal(result.state,'present');
  assert.equal(result.actual_state,'success');
  assert.equal(result.evidence.pages.length,2);
  assert.equal(result.evidence.pages[0].member_count,30);
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
