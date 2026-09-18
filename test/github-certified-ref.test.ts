import assert from 'node:assert/strict';
import test from 'node:test';
import { RECEIPT_SCHEMA, type ReceiptFact } from '../src/facts.ts';
import type { GitHubRefTargetPostcondition, Obligation } from '../src/model.ts';
import { observePostcondition } from '../src/observation.ts';
import {
  canonicalGithubRef,
  observeCertifiedGithubRefTarget,
} from '../src/providers/github-certified-ref.ts';
import type { GithubJsonGet } from '../src/providers/github-status.ts';
import { projectReceipt } from '../src/projection.ts';

const TARGET='a'.repeat(40);
const OTHER='b'.repeat(40);

function postcondition(
  ref='heads/main',
  targetSha=TARGET,
):GitHubRefTargetPostcondition {
  return {
    verifier:'github-ref-target/v1',
    provider:'github',
    repository_id:42,
    ref,
    target_sha:targetSha,
  };
}

function provider({
  actual=TARGET,
  objectType='commit',
  failure,
}:{
  actual?:string;
  objectType?:string;
  failure?:Error;
}={}):{get:GithubJsonGet;calls:string[]} {
  const calls:string[]=[];
  const get:GithubJsonGet=(_token,path)=>{
    calls.push(path);
    if (path==='/repositories/42') return {id:42,full_name:'acme/widget'};
    if (failure) throw failure;
    return {
      ref:'refs/heads/main',
      object:{type:objectType,sha:actual},
    };
  };
  return {get,calls};
}

function receiptFor(
  observed:ReturnType<typeof observePostcondition>,
  pc=postcondition(),
):ReturnType<typeof projectReceipt> {
  const work:Obligation={
    id:'ref-proof',
    dependencies:[],
    packet:{},
    postcondition:pc,
  };
  const fact:ReceiptFact={
    schema:RECEIPT_SCHEMA,
    run_id:'run-1',
    obligation_id:work.id,
    claimed_revision:'c'.repeat(40),
    claim_commit:'d'.repeat(40),
    kind:'observation',
    observed,
    settled_at:'2026-09-18T20:10:00Z',
  };
  return projectReceipt(fact,work);
}

test('exact certified GitHub ref binding settles DONE', () => {
  const p=provider();
  const pc=postcondition();
  const observed=observePostcondition(pc,{
    githubToken:'token',
    githubGet:p.get,
    clock:()=> '2026-09-18T20:10:00.000Z',
  });

  assert.equal(observed.mutation_certainty,'present');
  assert.equal(observed.ref,'refs/heads/main');
  assert.equal(observed.actual_target_sha,TARGET);
  assert.equal(receiptFor(observed,pc).disposition,'DONE');
  assert.match(p.calls[1],/git\/ref\/heads%2Fmain$/);
});

test('authoritative different ref target proves desired binding absent and returns READY', () => {
  const p=provider({actual:OTHER});
  const pc=postcondition();
  const observed=observePostcondition(pc,{
    githubToken:'token',
    githubGet:p.get,
    clock:()=> '2026-09-18T20:11:00.000Z',
  });

  assert.equal(observed.mutation_certainty,'absent');
  assert.equal(observed.actual_target_sha,OTHER);
  assert.equal(receiptFor(observed,pc).disposition,'READY');
});

test('failed or invisible ref read stays uncertain rather than proving absence', () => {
  const p=provider({failure:new Error('GITHUB_PROVIDER_READ_FAILED: 404')});
  const pc=postcondition();
  const observed=observePostcondition(pc,{
    githubToken:'token',
    githubGet:p.get,
    clock:()=> '2026-09-18T20:12:00.000Z',
  });

  assert.equal(observed.mutation_certainty,'uncertain');
  assert.equal(observed.negative_evidence_authoritative,false);
  assert.match(String(observed.observation_error),/404/);
  assert.equal(receiptFor(observed,pc).disposition,'RECOVERY_REQUIRED');
});

test('malformed ref response fails closed before it becomes provider truth', () => {
  const p=provider({objectType:'blob'});
  const pc=postcondition();
  const observed=observePostcondition(pc,{
    githubToken:'token',
    githubGet:p.get,
    clock:()=> '2026-09-18T20:13:00.000Z',
  });

  assert.equal(observed.mutation_certainty,'uncertain');
  assert.equal(observed.negative_evidence_authoritative,false);
  assert.match(String(observed.observation_error),/GITHUB_REF_OBJECT_TYPE_INVALID/);
  assert.equal(receiptFor(observed,pc).disposition,'RECOVERY_REQUIRED');
});

test('ref coordinate aliases canonicalize but arbitrary short names are rejected', () => {
  assert.equal(canonicalGithubRef('heads/main'),'refs/heads/main');
  assert.equal(canonicalGithubRef('refs/tags/v1'),'refs/tags/v1');
  assert.throws(()=>canonicalGithubRef('main'),/GITHUB_REF_COORDINATE_INVALID/);
});

test('certified ref reader exposes provider evidence for an authoritative mismatch', () => {
  const p=provider({actual:OTHER});
  const result=observeCertifiedGithubRefTarget('token',{
    repositoryId:42,
    ref:'refs/heads/main',
    targetSha:TARGET,
    get:p.get,
    clock:()=> '2026-09-18T20:14:00.000Z',
  });

  assert.equal(result.state,'absent');
  assert.equal(result.reason,'AUTHORITATIVE_BINDING_DIFFERS');
  assert.equal(result.evidence.operation_id,'git/get-ref');
  assert.deepEqual(result.evidence.validated_paths,['ref','object.type','object.sha']);
});
