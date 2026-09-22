import {canonicalDigest} from './digest.ts';
import {GITHUB_API_VERSION} from './providers/github-contract.ts';

export const GITHUB_OPERATOR_COMMAND_SCHEMA='overcenter-github-operator-command/v1' as const;
export const CANDIDATE_CERTIFY_COMMAND='candidate.certify' as const;
export const PROJECT_ADVANCE_COMMAND='project.advance' as const;
export const WORK_EXECUTE_COMMAND='work.execute' as const;

export type GithubOperatorCommand=
  | typeof CANDIDATE_CERTIFY_COMMAND
  | typeof PROJECT_ADVANCE_COMMAND
  | typeof WORK_EXECUTE_COMMAND;

export interface GithubOperatorCommandContext {
  repository_id:number;
  repository_full_name:string;
  source_sha:string;
  ref:string;
  command_run_id:number;
  command_run_attempt:number;
  head_repository_full_name?:string;
  pull_number?:number;
  default_branch?:string;
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

type DispatchedWorkflow='merge-gate.yml'|'project-advance.yml'|'work-execute.yml';

export interface GithubOperatorCommandReceipt {
  schema:typeof GITHUB_OPERATOR_COMMAND_SCHEMA;
  command:GithubOperatorCommand;
  transport:'github-actions-job-rerun';
  repository_id:number;
  repository_full_name:string;
  source_sha:string;
  ref:string;
  command_run_id:number;
  command_run_attempt:number;
  pull_number?:number;
  default_branch?:string;
  dispatched_workflow:DispatchedWorkflow;
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

function validRef(value:string|undefined,name:string):string {
  if (!value || /[\0\r\n\t ]/.test(value) || value.startsWith('-')) {
    throw new Error(`GITHUB_OPERATOR_REF_INVALID:${name}`);
  }
  return value;
}

function validateBaseContext(context:GithubOperatorCommandContext):void {
  positiveInteger(context.repository_id,'repository_id');
  positiveInteger(context.command_run_id,'command_run_id');
  positiveInteger(context.command_run_attempt,'command_run_attempt');
  if (context.command_run_attempt<2) {
    throw new Error('GITHUB_OPERATOR_COMMAND_NOT_INVOKED');
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(context.repository_full_name)) {
    throw new Error('GITHUB_OPERATOR_REPOSITORY_INVALID');
  }
  if (!/^[0-9a-f]{40}$/i.test(context.source_sha)) {
    throw new Error('GITHUB_OPERATOR_SOURCE_SHA_INVALID');
  }
  validRef(context.ref,'ref');
}

function candidateSubject(context:GithubOperatorCommandContext):{
  pull_number:number;
} {
  const pullNumber=Number(context.pull_number);
  positiveInteger(pullNumber,'pull_number');
  if (!context.head_repository_full_name) {
    throw new Error('GITHUB_OPERATOR_HEAD_REPOSITORY_REQUIRED');
  }
  if (context.head_repository_full_name!==context.repository_full_name) {
    throw new Error('GITHUB_OPERATOR_CROSS_REPOSITORY_HEAD_UNSUPPORTED');
  }
  return {pull_number:pullNumber};
}

function projectSubject(context:GithubOperatorCommandContext):{
  default_branch:string;
} {
  const defaultBranch=validRef(context.default_branch,'default_branch');
  if (context.ref!==defaultBranch) {
    throw new Error('GITHUB_OPERATOR_PROJECT_COMMAND_NOT_DEFAULT_BRANCH');
  }
  return {default_branch:defaultBranch};
}

function dispatchTarget(
  command:GithubOperatorCommand,
  context:GithubOperatorCommandContext,
):{
  workflow:DispatchedWorkflow;
  ref:string;
  subject:{pull_number:number}|{default_branch:string};
} {
  if (command===CANDIDATE_CERTIFY_COMMAND) {
    return {
      workflow:'merge-gate.yml',
      ref:context.ref,
      subject:candidateSubject(context),
    };
  }
  if (command===PROJECT_ADVANCE_COMMAND) {
    const subject=projectSubject(context);
    return {
      workflow:'project-advance.yml',
      ref:subject.default_branch,
      subject,
    };
  }
  if (command===WORK_EXECUTE_COMMAND) {
    const subject=projectSubject(context);
    return {
      workflow:'work-execute.yml',
      ref:subject.default_branch,
      subject,
    };
  }
  throw new Error('GITHUB_OPERATOR_COMMAND_UNSUPPORTED');
}

export function buildGithubOperatorDispatch(
  command:GithubOperatorCommand,
  context:GithubOperatorCommandContext,
):{path:string;body:GithubWorkflowDispatchBody} {
  validateBaseContext(context);
  const target=dispatchTarget(command,context);
  const [owner,repo]=context.repository_full_name.split('/');
  return {
    path:`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${target.workflow}/dispatches`,
    body:{
      ref:target.ref,
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
  validateBaseContext(context);
  const target=dispatchTarget(command,context);
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
    source_sha:context.source_sha.toLowerCase(),
    ref:context.ref,
    command_run_id:context.command_run_id,
    command_run_attempt:context.command_run_attempt,
    ...target.subject,
    dispatched_workflow:target.workflow,
    dispatched_run_id:dispatchedRunId,
    dispatched_run_url:dispatchedRunUrl,
    dispatched_html_url:dispatchedHtmlUrl,
  };
  return {
    ...base,
    receipt_digest:canonicalDigest(base),
  };
}
