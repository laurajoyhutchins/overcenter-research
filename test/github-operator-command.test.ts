import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGithubOperatorDispatch,
  CANDIDATE_CERTIFY_COMMAND,
  executeGithubOperatorCommand,
  type GithubOperatorCommandContext,
} from '../src/github-operator-command.ts';

const SHA='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function context(overrides:Partial<GithubOperatorCommandContext>={}):GithubOperatorCommandContext {
  return {
    repository_id:42,
    repository_full_name:'acme/widget',
    head_repository_full_name:'acme/widget',
    pull_number:7,
    source_sha:SHA,
    base_sha:BASE,
    ref:'feature/exact-head',
    command_run_id:9001,
    command_run_attempt:2,
    ...overrides,
  };
}

function providerRun(
  id:number,
  {
    status='completed',
    conclusion='success',
    event='workflow_dispatch',
    path='.github/workflows/merge-gate.yml',
    headSha=SHA,
    baseSha=BASE,
  }:{
    status?:string;
    conclusion?:string|null;
    event?:string;
    path?:string;
    headSha?:string;
    baseSha?:string;
  }={},
) {
  return {
    id,
    path,
    event,
    status,
    conclusion,
    head_sha:headSha,
    inputs:{source_sha:headSha,base_sha:baseSha},
    url:`https://api.github.com/repos/acme/widget/actions/runs/${id}`,
    html_url:`https://github.com/acme/widget/actions/runs/${id}`,
  };
}

function lookupWithRuns(runs:ReturnType<typeof providerRun>[]) {
  return async(_token:string,path:string)=>{
    if (path.includes('/actions/runs?')) {
      return {
        status:200,
        body:JSON.stringify({workflow_runs:runs.map(({inputs,...run})=>run)}),
      };
    }
    const id=Number(path.split('/').pop());
    const run=runs.find(candidate=>candidate.id===id);
    if (!run) return {status:404,body:'missing'};
    return {status:200,body:JSON.stringify(run)};
  };
}

const emptyLookup=lookupWithRuns([]);

test('candidate.certify maps to one exact head and base workflow dispatch',()=>{
  assert.deepEqual(
    buildGithubOperatorDispatch(CANDIDATE_CERTIFY_COMMAND,context()),
    {
      path:'/repos/acme/widget/actions/workflows/merge-gate.yml/dispatches',
      body:{
        ref:'feature/exact-head',
        inputs:{source_sha:SHA,base_sha:BASE},
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

test('dispatch returns an attributable head/base command receipt',async()=>{
  const calls:Array<{path:string;body:unknown}>=[];
  const receipt=await executeGithubOperatorCommand(
    'token',
    CANDIDATE_CERTIFY_COMMAND,
    context(),
    {
      get:emptyLookup,
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
  assert.equal(receipt.schema,'overcenter-github-operator-command/v2');
  assert.equal(receipt.source_sha,SHA);
  assert.equal(receipt.base_sha,BASE);
  assert.equal(receipt.result_mode,'dispatched');
  assert.equal(receipt.certification_run_id,1234);
  assert.match(receipt.receipt_digest,/^[0-9a-f]{64}$/);
});

test('candidate.certify reuses only successful exact-head exact-base certification',async()=>{
  let posts=0;
  const receipt=await executeGithubOperatorCommand(
    'token',
    CANDIDATE_CERTIFY_COMMAND,
    context(),
    {
      get:lookupWithRuns([
        providerRun(4322,{baseSha:'c'.repeat(40)}),
        providerRun(4321),
      ]),
      post:async()=>{
        posts+=1;
        return {status:500,body:'must not dispatch'};
      },
    },
  );
  assert.equal(posts,0);
  assert.equal(receipt.result_mode,'reused');
  assert.equal(receipt.certification_run_id,4321);
});

test('candidate.certify prefers completed success over a newer active duplicate',async()=>{
  const receipt=await executeGithubOperatorCommand(
    'token',
    CANDIDATE_CERTIFY_COMMAND,
    context(),
    {
      get:lookupWithRuns([
        providerRun(5000,{status:'in_progress',conclusion:null}),
        providerRun(4999),
      ]),
      post:async()=>({status:500,body:'must not dispatch'}),
    },
  );
  assert.equal(receipt.result_mode,'reused');
  assert.equal(receipt.certification_run_id,4999);
});

test('failed, stale-base, or unrelated runs do not suppress fresh certification',async()=>{
  let posts=0;
  const receipt=await executeGithubOperatorCommand(
    'token',
    CANDIDATE_CERTIFY_COMMAND,
    context(),
    {
      get:lookupWithRuns([
        providerRun(6000,{conclusion:'failure'}),
        providerRun(6001,{event:'pull_request'}),
        providerRun(6002,{headSha:'d'.repeat(40)}),
        providerRun(6004,{baseSha:'e'.repeat(40)}),
      ]),
      post:async()=>{
        posts+=1;
        return {
          status:200,
          body:JSON.stringify({
            workflow_run_id:6003,
            run_url:'https://api.github.com/repos/acme/widget/actions/runs/6003',
            html_url:'https://github.com/acme/widget/actions/runs/6003',
          }),
        };
      },
    },
  );
  assert.equal(posts,1);
  assert.equal(receipt.result_mode,'dispatched');
  assert.equal(receipt.certification_run_id,6003);
});

test('ambiguous certification lookup fails closed before dispatch',async()=>{
  let posts=0;
  await assert.rejects(
    executeGithubOperatorCommand(
      'token',
      CANDIDATE_CERTIFY_COMMAND,
      context(),
      {
        get:async()=>({status:503,body:'provider unavailable'}),
        post:async()=>{
          posts+=1;
          return {status:200,body:'{}'};
        },
      },
    ),
    /GITHUB_OPERATOR_CERTIFICATION_LOOKUP_FAILED:503/,
  );
  assert.equal(posts,0);

  await assert.rejects(
    executeGithubOperatorCommand(
      'token',
      CANDIDATE_CERTIFY_COMMAND,
      context(),
      {
        get:lookupWithRuns([{
          ...providerRun(7000),
          html_url:'https://github.com/acme/widget/actions/runs/9999',
        }]),
        post:async()=>{
          posts+=1;
          return {status:200,body:'{}'};
        },
      },
    ),
    /GITHUB_OPERATOR_CERTIFICATION_LOOKUP_RESPONSE_IDENTITY_MISMATCH/,
  );
  assert.equal(posts,0);
});

test('ambiguous or failed dispatch never produces a receipt',async()=>{
  await assert.rejects(
    executeGithubOperatorCommand(
      'token',
      CANDIDATE_CERTIFY_COMMAND,
      context(),
      {get:emptyLookup,post:async()=>({status:500,body:'provider unavailable'})},
    ),
    /GITHUB_OPERATOR_DISPATCH_FAILED:500/,
  );

  await assert.rejects(
    executeGithubOperatorCommand(
      'token',
      CANDIDATE_CERTIFY_COMMAND,
      context(),
      {get:emptyLookup,post:async()=>({status:200,body:'{}'})},
    ),
    /GITHUB_OPERATOR_INTEGER_INVALID:workflow_run_id/,
  );
});
