import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  GITHUB_COMMIT_STATUSES_OPERATION,
  GITHUB_PULL_REQUEST_OPERATION,
  GITHUB_REF_OPERATION,
  GITHUB_REPOSITORY_OPERATION,
} from '../src/providers/github-operations.generated.ts';
import { materializeGithubOperationRequest } from '../src/providers/github-openapi.ts';
import { GITHUB_OPERATION_SEMANTICS } from '../src/providers/github-semantics.ts';

test('generated GitHub operation catalog is bound to semantic operation IDs',()=>{
  assert.equal(GITHUB_REPOSITORY_OPERATION.operation_id,GITHUB_OPERATION_SEMANTICS.repository.operation_id);
  assert.equal(GITHUB_REF_OPERATION.operation_id,GITHUB_OPERATION_SEMANTICS.ref.operation_id);
  assert.equal(GITHUB_PULL_REQUEST_OPERATION.operation_id,GITHUB_OPERATION_SEMANTICS.pull_request.operation_id);
  assert.equal(GITHUB_COMMIT_STATUSES_OPERATION.operation_id,GITHUB_OPERATION_SEMANTICS.commit_statuses.operation_id);
});

test('GitHub request materialization is operation-driven',()=>{
  const request=materializeGithubOperationRequest(GITHUB_COMMIT_STATUSES_OPERATION,{
    owner:'acme',
    repo:'widget',
    ref:'heads/main',
    per_page:100,
    page:2,
  });
  assert.equal(request.path,'/repos/acme/widget/commits/heads%2Fmain/statuses?page=2&per_page=100');
  assert.deepEqual(request.parameters,{
    owner:'acme',
    ref:'heads/main',
    repo:'widget',
    page:2,
    per_page:100,
  });
  assert.throws(
    ()=>materializeGithubOperationRequest(GITHUB_REF_OPERATION,{owner:'acme',repo:'widget'}),
    /GITHUB_OPERATION_PARAMETER_REQUIRED:ref/,
  );
  assert.throws(
    ()=>materializeGithubOperationRequest(GITHUB_REF_OPERATION,{owner:'acme',repo:'widget',ref:'heads\/main',surprise:true}),
    /GITHUB_OPERATION_PARAMETER_UNKNOWN:surprise/,
  );
});

test('certified providers do not copy GitHub routes or response schemas',()=>{
  for (const path of [
    'src/providers/github-certified-repository.ts',
    'src/providers/github-certified-ref.ts',
    'src/providers/github-certified-pr.ts',
    'src/providers/github-certified-status.ts',
  ]) {
    const source=readFileSync(path,'utf8');
    assert.doesNotMatch(source,/path_template\s*:/,path);
    assert.doesNotMatch(source,/outcomes\s*:/,path);
    assert.doesNotMatch(source,/\/repos\/\{?owner/,path);
  }
});
