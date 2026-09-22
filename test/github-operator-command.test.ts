import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGithubOperatorDispatch,
  CANDIDATE_CERTIFY_COMMAND,
  executeGithubOperatorCommand,
  type GithubOperatorCommandContext,
} from '../src/github-operator-command.ts';

const SHA='a'.repeat(40);

function context(overrides:Partial<GithubOperatorCommandContext>={}):GithubOperatorCommandContext {
  return {
    repository_id:42,
    repository_full_name:'acme/widget',
    head_repository_full_name:'acme/widget',
    pull_number:7,
    source_sha:SHA,
    ref:'feature/exact-head',
    command_run_id:9001,
    command_run_attempt:2,
    ...overrides,
  };
}

test('candidate.certify maps to one exact workflow dispatch',()=>{
  assert.deepEqual(
    buildGithubOperatorDispatch(CANDIDATE_CERTIFY_COMMAND,context()),
    {
      path:'/repos/acme/widget/actions/workflows/merge-gate.yml/dispatches',
      body:{
        ref:'feature/exact-head',
        inputs:{source_sha:SHA},
      },
    },
  );
});

test('initial availability run is not an invocation',()=>{
  assert.throws(
    ()=>buildGithubOperatorDispatch(
      CANDIDATE_CERTIFY_COMMAND,
      context({command_run_attempt:1}),
    ),
    /GITHUB_OPERATOR_COMMAND_NOT_INVOKED/,
  );
});

test('cross-repository pull request heads fail closed',()=>{
  assert.throws(
    ()=>buildGithubOperatorDispatch(
      CANDIDATE_CERTIFY_COMMAND,
      context({head_repository_full_name:'someone/fork'}),
    ),
    /GITHUB_OPERATOR_CROSS_REPOSITORY_HEAD_UNSUPPORTED/,
  );
});

test('dispatch returns an attributable command receipt',async()=>{
  const calls:Array<{path:string;body:unknown}>=[];
  const receipt=await executeGithubOperatorCommand(
    'token',
    CANDIDATE_CERTIFY_COMMAND,
    context(),
    {
      post:async(_token,path,body)=>{
        calls.push({path,body});
        return {
          status:200,
          body:JSON.stringify({
            workflow_run_id:1234,
            run_url:'https://api.github.com/repos/acme/widget/actions/runs/1234',
            html_url:'https://github.com/acme/widget/actions/runs/1234',
          }),
        };
      },
    },
  );

  assert.equal(calls.length,1);
  assert.equal(receipt.command,'candidate.certify');
  assert.equal(receipt.source_sha,SHA);
  assert.equal(receipt.command_run_id,9001);
  assert.equal(receipt.command_run_attempt,2);
  assert.equal(receipt.dispatched_run_id,1234);
  assert.match(receipt.receipt_digest,/^[0-9a-f]{64}$/);
});

test('ambiguous or failed dispatch never produces a receipt',async()=>{
  await assert.rejects(
    executeGithubOperatorCommand(
      'token',
      CANDIDATE_CERTIFY_COMMAND,
      context(),
      {post:async()=>({status:500,body:'provider unavailable'})},
    ),
    /GITHUB_OPERATOR_DISPATCH_FAILED:500/,
  );

  await assert.rejects(
    executeGithubOperatorCommand(
      'token',
      CANDIDATE_CERTIFY_COMMAND,
      context(),
      {post:async()=>({status:200,body:'{}'})},
    ),
    /GITHUB_OPERATOR_INTEGER_INVALID:workflow_run_id/,
  );

  await assert.rejects(
    executeGithubOperatorCommand(
      'token',
      CANDIDATE_CERTIFY_COMMAND,
      context(),
      {
        post:async()=>({
          status:200,
          body:JSON.stringify({
            workflow_run_id:1234,
            run_url:'https://api.github.com/repos/acme/widget/actions/runs/9999',
            html_url:'https://github.com/acme/widget/actions/runs/1234',
          }),
        }),
      },
    ),
    /GITHUB_OPERATOR_DISPATCH_RESPONSE_IDENTITY_MISMATCH/,
  );
});
