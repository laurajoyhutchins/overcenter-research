import {canonicalDigest} from './digest.ts';
import {GITHUB_API_VERSION} from './providers/github-contract.ts';

export const GITHUB_OPERATOR_COMMAND_SCHEMA='overcenter-github-operator-command/v2' as const;
export const CANDIDATE_CERTIFY_COMMAND='candidate.certify' as const;

export type GithubOperatorCommand=typeof CANDIDATE_CERTIFY_COMMAND;

export interface GithubOperatorCommandContext {
  repository_id:number;
  repository_full_name:string;
  head_repository_full_name:string;
  pull_number:number;
  source_sha:string;
  base_sha:string;
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

export type GithubWorkflowRunsGet=(
  token:string,
  path:string,
)=>Promise<{status:number;body:string}>;

export interface GithubOperatorCommandReceipt {
  schema:typeof GITHUB_OPERATOR_COMMAND_SCHEMA;
  command:GithubOperatorCommand;
  transport:'github-actions-job-rerun';
  repository_id:number;
  repository_full_name:string;
  pull_number:number;
  source_sha:string;
  base_sha:string;
  ref:string;
  command_run_id:number;
  command_run_attempt:number;
  certification_workflow:'merge-gate.yml';
  result_mode:'dispatched'|'reused';
  certification_run_id:number;
  certification_run_url:string;
  certification_html_url:string;
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
  if (!/^[0-9a-f]{40}$/i.test(context.base_sha)) {
    throw new Error('GITHUB_OPERATOR_BASE_SHA_INVALID');
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
        base_sha:context.base_sha.toLowerCase(),
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

async function githubGet(
  token:string,
  path:string,
):Promise<{status:number;body:string}> {
  const response=await fetch(`https://api.github.com${path}`,{
    method:'GET',
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':GITHUB_API_VERSION,
    },
  });
  return {status:response.status,body:await response.text()};
}

function responseString(value:unknown,name:string):string {
  if (typeof value!=='string' || !value) {
    throw new Error(`GITHUB_OPERATOR_DISPATCH_RESPONSE_INVALID:${name}`);
  }
  return value;
}

interface ReusableCertificationRun {
  id:number;
  url:string;
  html_url:string;
  status:string;
  conclusion:string|null;
}

const ACTIVE_WORKFLOW_RUN_STATUSES=new Set([
  'requested',
  'queued',
  'in_progress',
  'waiting',
  'pending',
]);

function reusableCertificationRun(
  value:unknown,
  context:GithubOperatorCommandContext,
):ReusableCertificationRun|null {
  if (!value || typeof value!=='object') return null;
  const run=value as Record<string,unknown>;
  if (run.path!=='.github/workflows/merge-gate.yml') return null;
  if (run.event!=='workflow_dispatch') return null;
  if (
    typeof run.head_sha!=='string'
    || run.head_sha.toLowerCase()!==context.source_sha.toLowerCase()
  ) return null;

  const expectedTitle=`candidate.certify=${context.source_sha.toLowerCase()} base=${context.base_sha.toLowerCase()} event=workflow_dispatch`;
  if (run.display_title!==expectedTitle) return null;

  if (typeof run.status!=='string') {
    throw new Error('GITHUB_OPERATOR_CERTIFICATION_LOOKUP_RESPONSE_INVALID:status');
  }
  const conclusion=run.conclusion===null?null:
    typeof run.conclusion==='string'?run.conclusion:
      (()=>{throw new Error('GITHUB_OPERATOR_CERTIFICATION_LOOKUP_RESPONSE_INVALID:conclusion');})();
  const reusable=run.status==='completed'
    ? conclusion==='success'
    : ACTIVE_WORKFLOW_RUN_STATUSES.has(run.status);
  if (!reusable) return null;

  const id=Number(run.id);
  positiveInteger(id,'certification_run_id');
  if (typeof run.url!=='string' || !run.url) {
    throw new Error('GITHUB_OPERATOR_CERTIFICATION_LOOKUP_RESPONSE_INVALID:url');
  }
  if (typeof run.html_url!=='string' || !run.html_url) {
    throw new Error('GITHUB_OPERATOR_CERTIFICATION_LOOKUP_RESPONSE_INVALID:html_url');
  }
  const expectedRunUrl=`https://api.github.com/repos/${context.repository_full_name}/actions/runs/${id}`;
  const expectedHtmlUrl=`https://github.com/${context.repository_full_name}/actions/runs/${id}`;
  if (run.url!==expectedRunUrl || run.html_url!==expectedHtmlUrl) {
    throw new Error('GITHUB_OPERATOR_CERTIFICATION_LOOKUP_RESPONSE_IDENTITY_MISMATCH');
  }
  return {
    id,
    url:run.url,
    html_url:run.html_url,
    status:run.status,
    conclusion,
  };
}

async function findReusableCertification(
  token:string,
  context:GithubOperatorCommandContext,
  get:GithubWorkflowRunsGet,
):Promise<ReusableCertificationRun|null> {
  const [owner,repo]=context.repository_full_name.split('/');
  const path=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?head_sha=${encodeURIComponent(context.source_sha.toLowerCase())}&event=workflow_dispatch&per_page=100`;
  const response=await get(token,path);
  if (response.status!==200) {
    throw new Error(`GITHUB_OPERATOR_CERTIFICATION_LOOKUP_FAILED:${response.status}:${response.body}`);
  }
  let decoded:unknown;
  try {
    decoded=JSON.parse(response.body);
  } catch {
    throw new Error('GITHUB_OPERATOR_CERTIFICATION_LOOKUP_RESPONSE_INVALID:json');
  }
  if (!decoded || typeof decoded!=='object') {
    throw new Error('GITHUB_OPERATOR_CERTIFICATION_LOOKUP_RESPONSE_INVALID:object');
  }
  const workflowRuns=(decoded as Record<string,unknown>).workflow_runs;
  if (!Array.isArray(workflowRuns)) {
    throw new Error('GITHUB_OPERATOR_CERTIFICATION_LOOKUP_RESPONSE_INVALID:workflow_runs');
  }

  const candidates=workflowRuns
    .filter((value):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value))
    .filter(run=>
      run.path==='.github/workflows/merge-gate.yml'
      && run.event==='workflow_dispatch'
      && typeof run.head_sha==='string'
      && run.head_sha.toLowerCase()===context.source_sha.toLowerCase()
      && Number.isSafeInteger(Number(run.id))
      && Number(run.id)>0
    )
    .sort((left,right)=>{
      const leftSuccess=left.status==='completed'&&left.conclusion==='success'?1:0;
      const rightSuccess=right.status==='completed'&&right.conclusion==='success'?1:0;
      if (leftSuccess!==rightSuccess) return rightSuccess-leftSuccess;
      return Number(right.id)-Number(left.id);
    });

  for (const candidate of candidates) {
    const id=Number(candidate.id);
    const detail=await get(
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${id}`,
    );
    if (detail.status!==200) {
      throw new Error(`GITHUB_OPERATOR_CERTIFICATION_LOOKUP_FAILED:${detail.status}:${detail.body}`);
    }
    let run:unknown;
    try {
      run=JSON.parse(detail.body);
    } catch {
      throw new Error('GITHUB_OPERATOR_CERTIFICATION_LOOKUP_RESPONSE_INVALID:run-json');
    }
    const reusable=reusableCertificationRun(run,context);
    if (reusable) return reusable;
  }
  return null;
}

function buildCommandReceipt(
  command:GithubOperatorCommand,
  context:GithubOperatorCommandContext,
  resultMode:'dispatched'|'reused',
  run:{id:number;url:string;html_url:string},
):GithubOperatorCommandReceipt {
  const base={
    schema:GITHUB_OPERATOR_COMMAND_SCHEMA,
    command,
    transport:'github-actions-job-rerun' as const,
    repository_id:context.repository_id,
    repository_full_name:context.repository_full_name,
    pull_number:context.pull_number,
    source_sha:context.source_sha.toLowerCase(),
    base_sha:context.base_sha.toLowerCase(),
    ref:context.ref,
    command_run_id:context.command_run_id,
    command_run_attempt:context.command_run_attempt,
    certification_workflow:'merge-gate.yml' as const,
    result_mode:resultMode,
    certification_run_id:run.id,
    certification_run_url:run.url,
    certification_html_url:run.html_url,
  };
  return {
    ...base,
    receipt_digest:canonicalDigest(base),
  };
}

export async function executeGithubOperatorCommand(
  token:string,
  command:GithubOperatorCommand,
  context:GithubOperatorCommandContext,
  {
    get=githubGet,
    post=githubPost,
  }:{
    get?:GithubWorkflowRunsGet;
    post?:GithubWorkflowDispatchPost;
  }={},
):Promise<GithubOperatorCommandReceipt> {
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
  const request=buildGithubOperatorDispatch(command,context);
  const reusable=await findReusableCertification(token,context,get);
  if (reusable) {
    return buildCommandReceipt(command,context,'reused',reusable);
  }

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

  return buildCommandReceipt(command,context,'dispatched',{
    id:dispatchedRunId,
    url:dispatchedRunUrl,
    html_url:dispatchedHtmlUrl,
  });
}
