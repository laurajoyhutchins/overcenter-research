import assert from 'node:assert/strict';
import { observeCertifiedGithubPullRequestIdentity } from '../../src/providers/github-certified-pr.ts';

const token=process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');

const repositoryId=1354872053;
const repositoryFullName='laurajoyhutchins/overcenter-research';
const pullNumber=37;
const expected={
  node_id:'PR_kwDOUMG09c8AAAABEIvMtA',
  state:'open',
  head_sha:'a78e680739fb29ffb37a89a22ed4e3488a815170',
  base_ref:'experiment/certified-github-repository-bootstrap',
  base_sha:'56c87c49db4c455d569bdeeb3349e37a5698e338',
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
assert.equal(current.actual?.node_id,expected.node_id);
assert.equal(current.actual?.head_sha.toLowerCase(),expected.head_sha.toLowerCase());
assert.equal(current.actual?.base_sha.toLowerCase(),expected.base_sha.toLowerCase());
assert.equal(current.actual?.base_ref,expected.base_ref);
assert.equal(current.actual?.state,expected.state);
assert.equal(current.evidence?.repository.operation_id,'repos/get');
assert.equal(current.evidence?.operation_id,'pulls/get');

const stale=observeCertifiedGithubPullRequestIdentity(token,{
  repositoryId,
  repositoryFullName,
  pullNumber,
  expected:{...expected,head_sha:'0'.repeat(40)},
});

assert.equal(stale.state,'STALE');
assert.equal(stale.reason,'AUTHORITATIVE_PR_IDENTITY_DIFFERS');
assert.deepEqual(stale.differences,['head_sha']);
assert.equal(stale.actual?.head_sha.toLowerCase(),expected.head_sha.toLowerCase());

console.log(JSON.stringify({
  current:{
    state:current.state,
    pull_number:current.pull_number,
    pull_id:current.actual?.id,
    node_id:current.actual?.node_id,
    head_sha:current.actual?.head_sha,
    base_ref:current.actual?.base_ref,
    base_sha:current.actual?.base_sha,
    pr_state:current.actual?.state,
    repository_id:current.evidence?.repository_id,
    repository_node_id:current.evidence?.repository.node_id,
    operation_id:current.evidence?.operation_id,
    schema_sha256:current.evidence?.schema_sha256,
  },
  stale:{
    state:stale.state,
    differences:stale.differences,
    expected_head_sha:stale.expected.head_sha,
    actual_head_sha:stale.actual?.head_sha,
    reason:stale.reason,
  },
},null,2));
