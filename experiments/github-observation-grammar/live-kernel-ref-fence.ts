import assert from 'node:assert/strict';
import { observeCertifiedGithubRefFence } from '../../src/providers/github/certified-ref.ts';

const token=process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');

const sourceRef=process.env.SOURCE_REF;
if (!sourceRef) throw new Error('SOURCE_REF_REQUIRED');
const sourceSha=process.env.SOURCE_SHA;
if (!sourceSha) throw new Error('SOURCE_SHA_REQUIRED');

const repositoryId=1354872053;
const repositoryFullName='laurajoyhutchins/overcenter-research';
const ref=sourceRef.startsWith('refs/')?sourceRef:`heads/${sourceRef}`;

const current=observeCertifiedGithubRefFence(token,{
  repositoryId,
  repositoryFullName,
  ref,
  expectedSha:sourceSha,
});

assert.equal(current.state,'CURRENT');
assert.equal(current.reason,'AUTHORITATIVE_BINDING_MATCHES');
assert.equal(current.actual_sha?.toLowerCase(),sourceSha.toLowerCase());
assert.equal(current.evidence?.repository.operation_id,'repos/get');
assert.equal(current.evidence?.operation_id,'git/get-ref');

const wrongSha='0'.repeat(40);
assert.notEqual(sourceSha.toLowerCase(),wrongSha);
const stale=observeCertifiedGithubRefFence(token,{
  repositoryId,
  repositoryFullName,
  ref,
  expectedSha:wrongSha,
});

assert.equal(stale.state,'STALE');
assert.equal(stale.reason,'AUTHORITATIVE_BINDING_DIFFERS');
assert.equal(stale.actual_sha?.toLowerCase(),sourceSha.toLowerCase());

console.log(JSON.stringify({
  ref,
  current:{
    state:current.state,
    expected_sha:current.expected_sha,
    actual_sha:current.actual_sha,
    canonical_ref:current.evidence?.canonical_ref,
    repository_id:current.evidence?.repository_id,
    repository_node_id:current.evidence?.repository.node_id,
    operation_id:current.evidence?.operation_id,
    schema_sha256:current.evidence?.schema_sha256,
  },
  stale:{
    state:stale.state,
    expected_sha:stale.expected_sha,
    actual_sha:stale.actual_sha,
    reason:stale.reason,
  },
},null,2));
