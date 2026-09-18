import assert from 'node:assert/strict';
import {
  observeCertifiedGithubRepositoryIdentity,
} from '../../src/providers/github-certified-repository.ts';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const token=required('GITHUB_TOKEN');
const repositoryId=Number(required('GITHUB_REPOSITORY_ID'));
const expectedFullName=required('GITHUB_REPOSITORY_FULL_NAME');

const identity=observeCertifiedGithubRepositoryIdentity(token,{repositoryId});

assert.equal(identity.repository_id,repositoryId);
assert.equal(identity.full_name.toLowerCase(),expectedFullName.toLowerCase());
assert.equal(identity.evidence.operation_id,'repos/get');
assert.equal(identity.evidence.bootstrap_hint.authoritative,false);
assert.equal(identity.evidence.bootstrap_hint.repository_id,repositoryId);
assert.deepEqual(
  identity.evidence.validated_paths,
  ['id','node_id','full_name','name','owner.login'],
);

console.log(JSON.stringify({
  repository_id:identity.repository_id,
  node_id:identity.node_id,
  full_name:identity.full_name,
  operation_id:identity.evidence.operation_id,
  schema_sha256:identity.evidence.schema_sha256,
  bootstrap_hint:identity.evidence.bootstrap_hint,
  validated_paths:identity.evidence.validated_paths,
},null,2));
