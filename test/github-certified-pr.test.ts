import assert from 'node:assert/strict';
import test from 'node:test';
import {
  observeCertifiedGithubPullRequestIdentity,
} from '../src/providers/github/certified-pr.ts';
import type { GithubJsonGet } from '../src/providers/github/rest.ts';

const HEAD='a'.repeat(40);
const BASE='b'.repeat(40);
const NODE='PR_node_37';

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

function pull(overrides:Record<string,unknown>={}) {
  return {
    id:3700,
    node_id:NODE,
    number:37,
    state:'open',
    head:{sha:HEAD},
    base:{ref:'main',sha:BASE},
    ...overrides,
  };
}

function provider({
  repositoryBody=repository(),
  pullBody=pull(),
}:{
  repositoryBody?:unknown;
  pullBody?:unknown;
}={}):{get:GithubJsonGet;calls:string[]} {
  const calls:string[]=[];
  const get:GithubJsonGet=(_token,path)=>{
    calls.push(path);
    if (path==='/repos/acme/widget') return repositoryBody;
    if (path==='/repos/acme/widget/pulls/37') return pullBody;
    throw new Error(`unexpected provider path: ${path}`);
  };
  return {get,calls};
}

const expected={
  node_id:NODE,
  state:'open',
  head_sha:HEAD,
  base_ref:'main',
  base_sha:BASE,
};

test('certified PR identity proves exact work snapshot', () => {
  const p=provider();
  const result=observeCertifiedGithubPullRequestIdentity('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    pullNumber:37,
    expected,
    get:p.get,
    clock:()=> '2026-09-18T20:10:00.000Z',
  });

  assert.equal(result.state,'CURRENT');
  assert.equal(result.reason,'AUTHORITATIVE_PR_IDENTITY_MATCHES');
  assert.deepEqual(result.differences,[]);
  assert.equal(result.actual?.id,3700);
  assert.equal(result.actual?.node_id,NODE);
  assert.equal(result.evidence?.repository.operation_id,'repos/get');
  assert.equal(result.evidence?.operation_id,'pulls/get');
  assert.deepEqual(p.calls,['/repos/acme/widget','/repos/acme/widget/pulls/37']);
});

test('authoritative PR head drift is stale, not indeterminate', () => {
  const p=provider({pullBody:pull({head:{sha:'c'.repeat(40)}})});
  const result=observeCertifiedGithubPullRequestIdentity('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    pullNumber:37,
    expected,
    get:p.get,
  });

  assert.equal(result.state,'STALE');
  assert.equal(result.reason,'AUTHORITATIVE_PR_IDENTITY_DIFFERS');
  assert.deepEqual(result.differences,['head_sha']);
});

test('stable PR entity mismatch is stale and explicit', () => {
  const p=provider({pullBody:pull({node_id:'PR_other'})});
  const result=observeCertifiedGithubPullRequestIdentity('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    pullNumber:37,
    expected,
    get:p.get,
  });

  assert.equal(result.state,'STALE');
  assert.ok(result.differences?.includes('node_id'));
});

test('repository identity mismatch fails closed before PR read', () => {
  const p=provider({repositoryBody:repository({id:43})});
  const result=observeCertifiedGithubPullRequestIdentity('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    pullNumber:37,
    expected,
    get:p.get,
  });

  assert.equal(result.state,'INDETERMINATE');
  assert.equal(result.reason,'OBSERVATION_FAILED');
  assert.equal(result.observation_error,'GITHUB_REPOSITORY_IDENTITY_MISMATCH');
  assert.deepEqual(p.calls,['/repos/acme/widget']);
});

test('malformed PR response fails closed', () => {
  const p=provider({pullBody:{...pull(),head:{}}});
  const result=observeCertifiedGithubPullRequestIdentity('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    pullNumber:37,
    expected,
    get:p.get,
  });

  assert.equal(result.state,'INDETERMINATE');
  assert.match(String(result.observation_error),/RESPONSE_SLICE_REQUIRED_FIELD_MISSING:head\.sha/);
});

test('invalid expected work identity is rejected before provider access', () => {
  const p=provider();
  assert.throws(()=>observeCertifiedGithubPullRequestIdentity('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    pullNumber:37,
    expected:{...expected,head_sha:'main'},
    get:p.get,
  }),/GITHUB_PR_HEAD_SHA_INVALID/);
  assert.deepEqual(p.calls,[]);
});
