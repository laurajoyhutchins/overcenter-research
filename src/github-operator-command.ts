import {canonicalDigest} from './digest.ts';
import {GITHUB_API_VERSION} from './providers/github-contract.ts';

export const GITHUB_OPERATOR_COMMAND_SCHEMA='overcenter-github-operator-command/v1' as const;
export const CANDIDATE_CERTIFY_COMMAND='candidate.certify' as const;

export type GithubOperatorCommand=typeof CANDIDATE_CERTIFY_COMMAND;

export interface GithubOperatorCommandContext {
  repository_id:number;
  repository_full_name:string;
  head_repository_full_name:string;
  pull_number:number;
  source_sha:string;
  ref:string;
  command_run_id:number;
  command_run_attempt:number;
}

export interface GithubWorkflowDispatchBody {
  ref:string;
  inputs:Record<string,string>;
}

export type GithubWorkflowDispatchPost=(
  token:string,
  path:string,
  body:GithubWorkflowDispatchBody,
)=>Promise<{status:number;body:string}>;

export interface GithubOperatorCommandReceipt {
  schema:typeof GITHUB_OPERATOR_COMMAND_SCHEMA;
  command:GithubOperatorCommand;
  transport:'github-actions-job-rerun';
  repository_id:number;
  repository_full_name:string;
  pull_number:number;
  source_sha:string;
  ref:string;
  command_run_id:number;
  command_run_attempt:number;
  dispatched_workflow:'merge-gate.yml';
  dispatched_run_id:number;
  dispatched_run_url:string;
  dispatched_html_url:string;
  receipt_digest:string;
}

function positiveInteger(value:number,name:string):void {
  if (!Number.isSafeInteger(value) || value<=0) {
    throw new Error(`GITHUB_OPERATOR_INTEGER_INVALID:${name}`);
  }
}

function validateContext(context:GithubOperatorCommandContext):void {
  positiveInteger(context.repository_id,'repository_id');
  positiveInteger(context.pull_number,'pull_number');
  positiveInteger(context.command_run_id,'command_run_id');
  positiveInteger(context.command_run_attempt,'command_run_attempt');
  if (context.command_run_attempt<2) {
    throw new Error('GITHUB_OPERATOR_COMMAND_NOT_INVOKED');
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(context.repository_full_name)) {
    throw new Error('GITHUB_OPERATOR_REPOSITORY_INVALID');
  }
  if (context.head_repository_full_name!==context.repository_full_name) {
    throw new Error('GITHUB_OPERATOR_CROSS_REPOSITORY_HEAD_UNSUPPORTED');
  }
  if (!/^[0-9a-f]{40}$/i.test(context.source_sha)) {
    throw new Error('GITHUB_OPERATOR_SOURCE_SHA_INVALID');
  }
  if (
    !context.ref
    || /[\0\r\n\t ]/.test(context.ref)
    || context.ref.startsWith('-')
  ) {
    throw new Error('GITHUB_OPERATOR_REF_INVALID');
  }
}

export function buildGithubOperatorDispatch(
  command:GithubOperatorCommand,
  context:GithubOperatorCommandContext,
):{path:string;body:GithubWorkflowDispatchBody} {
  validateContext(context);
  if (command!==CANDIDATE_CERTIFY_COMMAND) {
    throw new Error('GITHUB_OPERATOR_COMMAND_UNSUPPORTED');
  }
  const [owner,repo]=context.repository_full_name.split('/');
  return {
    path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/merge-gate.yml/dispatches`,
    body:{
      ref:context.ref,
      inputs:{
        source_sha:context.source_sha.toLowerCase(),
      },
    },
  };
}

async function githubPost(
  token:string,
  path:string,
  body:GithubWorkflowDispatchBody,
):Promise<{status:number;body:string}> {
  const response=await fetch(`https://api.github.com${path}`,{
    method:'POST',
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':GITHUB_API_VERSION,
      'Content-Type':'application/json',
    },
    body:JSON.stringify(body),
  });
  return {status:response.status,body:await response.text()};
}

function responseString(value:unknown,name:string):string {
  if (typeof value!=='string' || !value) {
    throw new Error(`GITHUB_OPERATOR_DISPATCH_RESPONSE_INVALID:${name}`);
  }
  return value;
}

export async function executeGithubOperatorCommand(
  token:string,
  command:GithubOperatorCommand,
  context:GithubOperatorCommandContext,
  {post=githubPost}:{post?:GithubWorkflowDispatchPost}={},
):Promise<GithubOperatorCommandReceipt> {
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
  const request=buildGithubOperatorDispatch(command,context);
  const response=await post(token,request.path,request.body);
  if (response.status!==200) {
    throw new Error(`GITHUB_OPERATOR_DISPATCH_FAILED:${response.status}:${response.body}`);
  }

  let decoded:unknown;
  try {
    decoded=JSON.parse(response.body);
  } catch {
    throw new Error('GITHUB_OPERATOR_DISPATCH_RESPONSE_INVALID:json');
  }
  if (!decoded || typeof decoded!=='object') {
    throw new Error('GITHUB_OPERATOR_DISPATCH_RESPONSE_INVALID:object');
  }
  const payload=decoded as Record<string,unknown>;
  const dispatchedRunId=Number(payload.workflow_run_id);
  positiveInteger(dispatchedRunId,'workflow_run_id');

  const dispatchedRunUrl=responseString(payload.run_url,'run_url');
  const dispatchedHtmlUrl=responseString(payload.html_url,'html_url');
  const expectedRunUrl=`https://api.github.com/repos/${context.repository_full_name}/actions/runs/${dispatchedRunId}`;
  const expectedHtmlUrl=`https://github.com/${context.repository_full_name}/actions/runs/${dispatchedRunId}`;
  if (dispatchedRunUrl!==expectedRunUrl || dispatchedHtmlUrl!==expectedHtmlUrl) {
    throw new Error('GITHUB_OPERATOR_DISPATCH_RESPONSE_IDENTITY_MISMATCH');
  }

  const base={
    schema:GITHUB_OPERATOR_COMMAND_SCHEMA,
    command,
    transport:'github-actions-job-rerun' as const,
    repository_id:context.repository_id,
    repository_full_name:context.repository_full_name,
    pull_number:context.pull_number,
    source_sha:context.source_sha.toLowerCase(),
    ref:context.ref,
    command_run_id:context.command_run_id,
    command_run_attempt:context.command_run_attempt,
    dispatched_workflow:'merge-gate.yml' as const,
    dispatched_run_id:dispatchedRunId,
    dispatched_run_url:dispatchedRunUrl,
    dispatched_html_url:dispatchedHtmlUrl,
  };
  return {
    ...base,
    receipt_digest:canonicalDigest(base),
  };
}
