import type { ResponseFieldSpec } from '../provider-observation/response-slice.ts';

export type GithubRepositoryReadPermission=
  |'actions:read'
  |'checks:read'
  |'contents:read'
  |'deployments:read'
  |'issues:read'
  |'pull_requests:read'
  |'statuses:read';

export interface GithubSemanticOperation {
  operation_id:string;
  required_permissions:readonly GithubRepositoryReadPermission[];
  response_slice:readonly ResponseFieldSpec[];
}


type ResponseFieldInput=string|ResponseFieldSpec;

function optional(path:string):ResponseFieldSpec {
  return {path,required:false};
}

function fields(...members:readonly ResponseFieldInput[]):readonly ResponseFieldSpec[] {
  return members.map(member=>typeof member==='string'?{path:member}:member);
}

function nested(
  prefix:string,
  members:readonly ResponseFieldSpec[],
  totalCount=false,
):readonly ResponseFieldSpec[] {
  return [
    ...(totalCount?[{path:'total_count'}]:[]),
    ...members.map(member=>({...member,path:`${prefix}.${member.path}`})),
  ];
}

function operation<Id extends string,Permission extends GithubRepositoryReadPermission>(
  operation_id:Id,
  required_permission:Permission,
  response_slice:readonly ResponseFieldSpec[],
) {
  return {
    operation_id,
    required_permissions:[required_permission] as const,
    response_slice,
  };
}

const BRANCH_FIELDS=fields("name","commit.sha","protected");
const CHECK_RUN_FIELDS=fields("id","node_id","head_sha","name","status","conclusion","started_at","completed_at");
const CHECK_SUITE_FIELDS=fields("id","node_id","head_sha","head_branch","status","conclusion","created_at","updated_at");
const WORKFLOW_FIELDS=fields("id","node_id","name","path","state","created_at","updated_at");
const WORKFLOW_JOB_FIELDS=fields("id","run_id","run_attempt","node_id","head_sha","name","status","conclusion","started_at","completed_at");
const COMMIT_FIELDS=fields("sha","node_id","commit.tree.sha","parents[].sha");
const ARTIFACT_FIELDS=fields("id","node_id","name","size_in_bytes","expired","created_at","expires_at","updated_at");

export const GITHUB_OPERATION_SEMANTICS={
  repository:operation("repos/get","contents:read",fields("id","node_id","full_name","name","owner.login")),
  ref:operation("git/get-ref","contents:read",fields("ref","object.type","object.sha")),
  git_commit:operation("git/get-commit","contents:read",fields("sha","node_id","tree.sha","parents[].sha")),
  branch:operation("repos/get-branch","contents:read",BRANCH_FIELDS),
  pull_request:operation("pulls/get","pull_requests:read",fields("id","node_id","number","state","head.sha","base.ref","base.sha")),
  issue:operation("issues/get","issues:read",fields("id","node_id","number","state",optional("state_reason"),"title","locked","updated_at",optional("pull_request.url"))),
  check_run:operation("checks/get","checks:read",CHECK_RUN_FIELDS),
  check_suite:operation("checks/get-suite","checks:read",CHECK_SUITE_FIELDS),
  commit_statuses:operation("repos/list-commit-statuses-for-ref","statuses:read",fields("[].id","[].node_id","[].state","[].context","[].target_url","[].created_at","[].updated_at")),
  combined_commit_status:operation("repos/get-combined-status-for-ref","statuses:read",fields("state","sha","total_count","repository.id","repository.node_id","repository.full_name","repository.name","repository.owner.login","statuses[].id","statuses[].node_id","statuses[].state","statuses[].context","statuses[].target_url","statuses[].created_at","statuses[].updated_at")),
  workflow:operation("actions/get-workflow","actions:read",WORKFLOW_FIELDS),
  workflow_run:operation("actions/get-workflow-run","actions:read",fields("id","node_id","workflow_id","run_number","run_attempt","name","event","status","conclusion","head_sha","head_branch","path","created_at","updated_at")),
  workflow_job:operation("actions/get-job-for-workflow-run","actions:read",WORKFLOW_JOB_FIELDS),
  release:operation("repos/get-release","contents:read",fields("id","node_id","tag_name","target_commitish","name","draft","prerelease","immutable","published_at","updated_at")),
  release_asset:operation("repos/get-release-asset","contents:read",fields("id","node_id","name","state","content_type","size","digest","download_count","created_at","updated_at")),
  deployment:operation("repos/get-deployment","deployments:read",fields("id","node_id","sha","ref","task","environment","description","created_at","updated_at")),
  deployment_status:operation("repos/get-deployment-status","deployments:read",fields("id","node_id","state","environment","description","target_url","created_at","updated_at")),
  pull_request_files:operation("pulls/list-files","pull_requests:read",fields("[].sha","[].filename","[].status","[].additions","[].deletions","[].changes")),
  pull_request_reviews:operation("pulls/list-reviews","pull_requests:read",fields("[].id","[].node_id","[].state","[].commit_id",optional("[].user.login"),optional("[].body"),optional("[].submitted_at"))),
  pull_request_review_comments:operation("pulls/list-review-comments","pull_requests:read",fields("[].id","[].node_id","[].path","[].commit_id",optional("[].user.login"),"[].body",optional("[].line"),optional("[].side"),optional("[].start_line"),optional("[].start_side"),optional("[].in_reply_to_id"),"[].updated_at")),
  issue_comments:operation("issues/list-comments","issues:read",fields("[].id","[].node_id",optional("[].user.login"),"[].body","[].created_at","[].updated_at")),
  issue_events:operation("issues/list-events","issues:read",fields("[].id","[].node_id","[].event","[].created_at")),
  issues:operation("issues/list-for-repo","issues:read",fields("[].id","[].node_id","[].number","[].state","[].title",optional("[].pull_request.url"),"[].updated_at")),
  pull_requests:operation("pulls/list","pull_requests:read",fields("[].id","[].node_id","[].number","[].state","[].title",optional("[].user.login"),"[].head.sha","[].base.ref","[].base.sha","[].updated_at")),
  commits:operation("repos/list-commits","contents:read",nested("[]",COMMIT_FIELDS)),
  commit:operation("repos/get-commit","contents:read",COMMIT_FIELDS),
  compare_commits:operation("repos/compare-commits","contents:read",fields("status","ahead_by","behind_by","base_commit.sha","merge_base_commit.sha")),
  git_tree:operation("git/get-tree","contents:read",fields("sha","truncated","tree[].path","tree[].mode","tree[].type","tree[].sha")),
  git_blob:operation("git/get-blob","contents:read",fields("sha","node_id","size","encoding","content")),
  workflow_runs:operation("actions/list-workflow-runs-for-repo","actions:read",fields("total_count","workflow_runs[].id","workflow_runs[].node_id","workflow_runs[].workflow_id","workflow_runs[].run_number","workflow_runs[].run_attempt","workflow_runs[].status","workflow_runs[].conclusion","workflow_runs[].head_sha","workflow_runs[].head_branch","workflow_runs[].updated_at")),
  workflow_jobs:operation("actions/list-jobs-for-workflow-run","actions:read",nested("jobs[]",WORKFLOW_JOB_FIELDS,true)),
  workflow_run_artifacts:operation("actions/list-workflow-run-artifacts","actions:read",nested("artifacts[]",ARTIFACT_FIELDS,true)),
  artifact:operation("actions/get-artifact","actions:read",ARTIFACT_FIELDS),
  workflows:operation("actions/list-repo-workflows","actions:read",nested("workflows[]",WORKFLOW_FIELDS,true)),
  check_runs_for_ref:operation("checks/list-for-ref","checks:read",nested("check_runs[]",CHECK_RUN_FIELDS,true)),
  check_suites_for_ref:operation("checks/list-suites-for-ref","checks:read",nested("check_suites[]",CHECK_SUITE_FIELDS,true)),
  branches:operation("repos/list-branches","contents:read",nested("[]",BRANCH_FIELDS)),
  tags:operation("repos/list-tags","contents:read",fields("[].name","[].commit.sha")),
  releases:operation("repos/list-releases","contents:read",fields("[].id","[].node_id","[].tag_name","[].target_commitish","[].draft","[].prerelease","[].immutable","[].published_at","[].updated_at")),
  deployments:operation("repos/list-deployments","deployments:read",fields("[].id","[].node_id","[].sha","[].ref","[].task","[].environment","[].created_at","[].updated_at")),
  deployment_statuses:operation("repos/list-deployment-statuses","deployments:read",fields("[].id","[].node_id","[].state","[].environment","[].created_at","[].updated_at")),
  commit_pull_requests:operation("repos/list-pull-requests-associated-with-commit","pull_requests:read",fields("[].id","[].node_id","[].number","[].state","[].head.sha","[].base.ref","[].base.sha","[].updated_at")),
  check_runs_for_suite:operation("checks/list-for-suite","checks:read",nested("check_runs[]",CHECK_RUN_FIELDS,true)),
} as const satisfies Record<string,GithubSemanticOperation>;

export function githubResponseSlice(operationId:string):readonly ResponseFieldSpec[] {
  const matches=Object.values(GITHUB_OPERATION_SEMANTICS)
    .filter(candidate=>candidate.operation_id===operationId);
  if (matches.length!==1) {
    throw new Error(
      matches.length===0
        ?`GITHUB_OPERATION_SEMANTICS_NOT_FOUND:${operationId}`
        :`GITHUB_OPERATION_SEMANTICS_DUPLICATE:${operationId}`,
    );
  }
  return matches[0].response_slice;
}

export type GithubSemanticOperationName=keyof typeof GITHUB_OPERATION_SEMANTICS;

export const GITHUB_REPOSITORY_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.repository.response_slice;
export const GITHUB_REF_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.ref.response_slice;
export const GITHUB_GIT_COMMIT_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.git_commit.response_slice;
export const GITHUB_BRANCH_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.branch.response_slice;
export const GITHUB_PULL_REQUEST_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.pull_request.response_slice;
export const GITHUB_ISSUE_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.issue.response_slice;
export const GITHUB_CHECK_RUN_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.check_run.response_slice;
export const GITHUB_CHECK_SUITE_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.check_suite.response_slice;
export const GITHUB_COMMIT_STATUSES_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.commit_statuses.response_slice;
export const GITHUB_COMBINED_COMMIT_STATUS_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.combined_commit_status.response_slice;
export const GITHUB_WORKFLOW_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.workflow.response_slice;
export const GITHUB_WORKFLOW_RUN_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.workflow_run.response_slice;
export const GITHUB_WORKFLOW_JOB_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.workflow_job.response_slice;
export const GITHUB_RELEASE_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.release.response_slice;
export const GITHUB_RELEASE_ASSET_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.release_asset.response_slice;
export const GITHUB_DEPLOYMENT_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.deployment.response_slice;
export const GITHUB_DEPLOYMENT_STATUS_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.deployment_status.response_slice;
// Preserve the established public name while the registry key remains plural.
export const GITHUB_COMMIT_STATUS_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.commit_statuses.response_slice;
export const GITHUB_COMPARE_COMMITS_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.compare_commits.response_slice;
