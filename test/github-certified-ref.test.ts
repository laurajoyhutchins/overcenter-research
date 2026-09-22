import assert from 'node:assert/strict';
import test from 'node:test';
import {
  observeCertifiedGithubRefFence,
} from '../src/providers/github/certified-ref.ts';
import type { GithubJsonGet } from '../src/providers/github/rest.ts';

const SHA_A='a'.repeat(40);
const SHA_B='b'.repeat(40);

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

function provider({
  repositoryBody=repository(),
  refBody={ref:'refs/heads/main',object:{type:'commit',sha:SHA_A}},
}:{
  repositoryBody?:unknown;
  refBody?:unknown;
}={}):{get:GithubJsonGet;calls:string[]} {
  const calls:string[]=[];
  const get:GithubJsonGet=(_token,path)=>{
    calls.push(path);
    if (path==='/repos/acme/widget') return repositoryBody;
    if (path==='/repos/acme/widget/git/ref/heads%2Fmain') return refBody;
    throw new Error(`unexpected provider path: ${path}`);
  };
  return {get,calls};
}

test('certified ref fence proves exact current binding', () => {
  const p=provider();
  const result=observeCertifiedGithubRefFence('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    ref:'heads/main',
    expectedSha:SHA_A,
    get:p.get,
    clock:()=> '2026-09-18T20:00:00.000Z',
  });

  assert.equal(result.state,'CURRENT');
  assert.equal(result.reason,'AUTHORITATIVE_BINDING_MATCHES');
  assert.equal(result.ref,'refs/heads/main');
  assert.equal(result.actual_sha,SHA_A);
  assert.equal(result.repository_full_name,'acme/widget');
  assert.equal(result.evidence?.repository.operation_id,'repos/get');
  assert.equal(result.evidence?.operation_id,'git/get-ref');
  assert.deepEqual(p.calls,[
    '/repos/acme/widget',
    '/repos/acme/widget/git/ref/heads%2Fmain',
  ]);
});

test('certified ref fence reports authoritative revision drift as stale', () => {
  const p=provider();
  const result=observeCertifiedGithubRefFence('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    ref:'refs/heads/main',
    expectedSha:SHA_B,
    get:p.get,
    clock:()=> '2026-09-18T20:01:00.000Z',
  });

  assert.equal(result.state,'STALE');
  assert.equal(result.reason,'AUTHORITATIVE_BINDING_DIFFERS');
  assert.equal(result.expected_sha,SHA_B);
  assert.equal(result.actual_sha,SHA_A);
});

test('repository identity mismatch fails closed instead of becoming stale', () => {
  const p=provider({repositoryBody:repository({id:43})});
  const result=observeCertifiedGithubRefFence('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    ref:'heads/main',
    expectedSha:SHA_A,
    get:p.get,
  });

  assert.equal(result.state,'INDETERMINATE');
  assert.equal(result.reason,'OBSERVATION_FAILED');
  assert.equal(result.observation_error,'GITHUB_REPOSITORY_IDENTITY_MISMATCH');
  assert.equal(result.actual_sha,undefined);
  assert.deepEqual(p.calls,['/repos/acme/widget']);
});

test('malformed ref response fails closed', () => {
  const p=provider({refBody:{ref:'refs/heads/main',object:{type:'commit'}}});
  const result=observeCertifiedGithubRefFence('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    ref:'heads/main',
    expectedSha:SHA_A,
    get:p.get,
  });

  assert.equal(result.state,'INDETERMINATE');
  assert.equal(result.reason,'OBSERVATION_FAILED');
  assert.match(String(result.observation_error),/RESPONSE_SLICE_REQUIRED_FIELD_MISSING:object\.sha/);
});

test('invalid expected SHA is rejected before provider access', () => {
  const p=provider();
  assert.throws(()=>observeCertifiedGithubRefFence('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    ref:'heads/main',
    expectedSha:'main',
    get:p.get,
  }),/GITHUB_REF_EXPECTED_SHA_INVALID/);
  assert.deepEqual(p.calls,[]);
});
