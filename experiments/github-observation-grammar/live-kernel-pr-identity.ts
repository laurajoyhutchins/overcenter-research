import assert from 'node:assert/strict';
import { observeCertifiedGithubPullRequestIdentity } from '../../src/providers/github/certified-pr.ts';

const token=process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');

const pullNumber=Number(process.env.PULL_NUMBER);
if (!Number.isSafeInteger(pullNumber) || pullNumber<=0) throw new Error('PULL_NUMBER_REQUIRED');
const nodeId=process.env.PR_NODE_ID;
const prState=process.env.PR_STATE;
const headSha=process.env.PR_HEAD_SHA;
const baseRef=process.env.PR_BASE_REF;
const baseSha=process.env.PR_BASE_SHA;
if (!nodeId || !prState || !headSha || !baseRef || !baseSha) {
  throw new Error('PR_IDENTITY_ENV_REQUIRED');
}

const repositoryId=1354872053;
const repositoryFullName='laurajoyhutchins/overcenter-research';
const expected={
  node_id:nodeId,
  state:prState,
  head_sha:headSha,
  base_ref:baseRef,
  base_sha:baseSha,
};

const current=observeCertifiedGithubPullRequestIdentity(token,{
  repositoryId,
  repositoryFullName,
  pullNumber,
  expected,
});
assert.equal(current.state,'CURRENT');
assert.equal(current.reason,'AUTHORITATIVE_PR_IDENTITY_MATCHES');
assert.deepEqual(current.differences,[]);

const stale=observeCertifiedGithubPullRequestIdentity(token,{
  repositoryId,
  repositoryFullName,
  pullNumber,
  expected:{...expected,head_sha:'0'.repeat(40)},
});
assert.equal(stale.state,'STALE');
assert.equal(stale.reason,'AUTHORITATIVE_PR_IDENTITY_DIFFERS');
assert.deepEqual(stale.differences,['head_sha']);

console.log(JSON.stringify({
  current:{
    state:current.state,
    pull_number:current.pull_number,
    node_id:current.actual?.node_id,
    head_sha:current.actual?.head_sha,
    base_ref:current.actual?.base_ref,
    base_sha:current.actual?.base_sha,
    pr_state:current.actual?.state,
    repository_id:current.evidence?.repository_id,
    operation_id:current.evidence?.operation_id,
    schema_sha256:current.evidence?.schema_sha256,
  },
  stale:{
    state:stale.state,
    differences:stale.differences,
    expected_head_sha:stale.expected.head_sha,
    actual_head_sha:stale.actual?.head_sha,
  },
},null,2));
