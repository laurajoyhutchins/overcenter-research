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

export const GITHUB_OPERATION_SEMANTICS={
  repository:{
    operation_id:"repos/get",
    required_permissions:["contents:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "node_id"
      },
      {
        "path": "full_name"
      },
      {
        "path": "name"
      },
      {
        "path": "owner.login"
      }
    ],
  },
  ref:{
    operation_id:"git/get-ref",
    required_permissions:["contents:read"],
    response_slice:[
      {
        "path": "ref"
      },
      {
        "path": "object.type"
      },
      {
        "path": "object.sha"
      }
    ],
  },
  git_commit:{
    operation_id:"git/get-commit",
    required_permissions:["contents:read"],
    response_slice:[
      {
        "path": "sha"
      },
      {
        "path": "node_id"
      },
      {
        "path": "tree.sha"
      },
      {
        "path": "parents[].sha"
      }
    ],
  },
  branch:{
    operation_id:"repos/get-branch",
    required_permissions:["contents:read"],
    response_slice:[
      {
        "path": "name"
      },
      {
        "path": "commit.sha"
      },
      {
        "path": "protected"
      }
    ],
  },
  pull_request:{
    operation_id:"pulls/get",
    required_permissions:["pull_requests:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "node_id"
      },
      {
        "path": "number"
      },
      {
        "path": "state"
      },
      {
        "path": "head.sha"
      },
      {
        "path": "base.ref"
      },
      {
        "path": "base.sha"
      }
    ],
  },
  issue:{
    operation_id:"issues/get",
    required_permissions:["issues:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "node_id"
      },
      {
        "path": "number"
      },
      {
        "path": "state"
      },
      {
        "path": "state_reason",
        "required": false
      },
      {
        "path": "title"
      },
      {
        "path": "locked"
      },
      {
        "path": "updated_at"
      },
      {
        "path": "pull_request.url",
        "required": false
      }
    ],
  },
  check_run:{
    operation_id:"checks/get",
    required_permissions:["checks:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "node_id"
      },
      {
        "path": "head_sha"
      },
      {
        "path": "name"
      },
      {
        "path": "status"
      },
      {
        "path": "conclusion"
      },
      {
        "path": "started_at"
      },
      {
        "path": "completed_at"
      }
    ],
  },
  check_suite:{
    operation_id:"checks/get-suite",
    required_permissions:["checks:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "node_id"
      },
      {
        "path": "head_sha"
      },
      {
        "path": "head_branch"
      },
      {
        "path": "status"
      },
      {
        "path": "conclusion"
      },
      {
        "path": "created_at"
      },
      {
        "path": "updated_at"
      }
    ],
  },
  commit_statuses:{
    operation_id:"repos/list-commit-statuses-for-ref",
    required_permissions:["statuses:read"],
    response_slice:[
      {
        "path": "[].id"
      },
      {
        "path": "[].node_id"
      },
      {
        "path": "[].state"
      },
      {
        "path": "[].context"
      },
      {
        "path": "[].target_url"
      },
      {
        "path": "[].created_at"
      },
      {
        "path": "[].updated_at"
      }
    ],
  },
  combined_commit_status:{
    operation_id:"repos/get-combined-status-for-ref",
    required_permissions:["statuses:read"],
    response_slice:[
      {
        "path": "state"
      },
      {
        "path": "sha"
      },
      {
        "path": "total_count"
      },
      {
        "path": "statuses[].id"
      },
      {
        "path": "statuses[].node_id"
      },
      {
        "path": "statuses[].state"
      },
      {
        "path": "statuses[].context"
      },
      {
        "path": "statuses[].target_url"
      },
      {
        "path": "statuses[].created_at"
      },
      {
        "path": "statuses[].updated_at"
      }
    ],
  },
  workflow:{
    operation_id:"actions/get-workflow",
    required_permissions:["actions:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "node_id"
      },
      {
        "path": "name"
      },
      {
        "path": "path"
      },
      {
        "path": "state"
      },
      {
        "path": "created_at"
      },
      {
        "path": "updated_at"
      }
    ],
  },
  workflow_run:{
    operation_id:"actions/get-workflow-run",
    required_permissions:["actions:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "node_id"
      },
      {
        "path": "workflow_id"
      },
      {
        "path": "run_number"
      },
      {
        "path": "run_attempt"
      },
      {
        "path": "name"
      },
      {
        "path": "event"
      },
      {
        "path": "status"
      },
      {
        "path": "conclusion"
      },
      {
        "path": "head_sha"
      },
      {
        "path": "head_branch"
      },
      {
        "path": "path"
      },
      {
        "path": "created_at"
      },
      {
        "path": "updated_at"
      }
    ],
  },
  workflow_job:{
    operation_id:"actions/get-job-for-workflow-run",
    required_permissions:["actions:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "run_id"
      },
      {
        "path": "run_attempt"
      },
      {
        "path": "node_id"
      },
      {
        "path": "head_sha"
      },
      {
        "path": "name"
      },
      {
        "path": "status"
      },
      {
        "path": "conclusion"
      },
      {
        "path": "started_at"
      },
      {
        "path": "completed_at"
      }
    ],
  },
  release:{
    operation_id:"repos/get-release",
    required_permissions:["contents:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "node_id"
      },
      {
        "path": "tag_name"
      },
      {
        "path": "target_commitish"
      },
      {
        "path": "name"
      },
      {
        "path": "draft"
      },
      {
        "path": "prerelease"
      },
      {
        "path": "immutable"
      },
      {
        "path": "published_at"
      },
      {
        "path": "updated_at"
      }
    ],
  },
  release_asset:{
    operation_id:"repos/get-release-asset",
    required_permissions:["contents:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "node_id"
      },
      {
        "path": "name"
      },
      {
        "path": "state"
      },
      {
        "path": "content_type"
      },
      {
        "path": "size"
      },
      {
        "path": "digest"
      },
      {
        "path": "download_count"
      },
      {
        "path": "created_at"
      },
      {
        "path": "updated_at"
      }
    ],
  },
  deployment:{
    operation_id:"repos/get-deployment",
    required_permissions:["deployments:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "node_id"
      },
      {
        "path": "sha"
      },
      {
        "path": "ref"
      },
      {
        "path": "task"
      },
      {
        "path": "environment"
      },
      {
        "path": "description"
      },
      {
        "path": "created_at"
      },
      {
        "path": "updated_at"
      }
    ],
  },
  deployment_status:{
    operation_id:"repos/get-deployment-status",
    required_permissions:["deployments:read"],
    response_slice:[
      {
        "path": "id"
      },
      {
        "path": "node_id"
      },
      {
        "path": "state"
      },
      {
        "path": "environment"
      },
      {
        "path": "description"
      },
      {
        "path": "target_url"
      },
      {
        "path": "created_at"
      },
      {
        "path": "updated_at"
      }
    ],
  },

  pull_request_files:{
    operation_id:"pulls/list-files",
    required_permissions:["pull_requests:read"],
    response_slice:[
      {path:"[].sha"},
      {path:"[].filename"},
      {path:"[].status"},
      {path:"[].additions"},
      {path:"[].deletions"},
      {path:"[].changes"},
    ],
  },
  pull_request_reviews:{
    operation_id:"pulls/list-reviews",
    required_permissions:["pull_requests:read"],
    response_slice:[
      {path:"[].id"},
      {path:"[].node_id"},
      {path:"[].state"},
      {path:"[].commit_id"},
      {path:"[].user.login",required:false},
      {path:"[].body",required:false},
      {path:"[].submitted_at",required:false},
    ],
  },
  pull_request_review_comments:{
    operation_id:"pulls/list-review-comments",
    required_permissions:["pull_requests:read"],
    response_slice:[
      {path:"[].id"},
      {path:"[].node_id"},
      {path:"[].path"},
      {path:"[].commit_id"},
      {path:"[].user.login",required:false},
      {path:"[].body"},
      {path:"[].line",required:false},
      {path:"[].side",required:false},
      {path:"[].start_line",required:false},
      {path:"[].start_side",required:false},
      {path:"[].in_reply_to_id",required:false},
      {path:"[].updated_at"},
    ],
  },
  issue_comments:{
    operation_id:"issues/list-comments",
    required_permissions:["issues:read"],
    response_slice:[
      {path:"[].id"},
      {path:"[].node_id"},
      {path:"[].user.login",required:false},
      {path:"[].body"},
      {path:"[].created_at"},
      {path:"[].updated_at"},
    ],
  },
  issue_events:{
    operation_id:"issues/list-events",
    required_permissions:["issues:read"],
    response_slice:[
      {path:"[].id"},
      {path:"[].node_id"},
      {path:"[].event"},
      {path:"[].created_at"},
    ],
  },
  issues:{
    operation_id:"issues/list-for-repo",
    required_permissions:["issues:read"],
    response_slice:[
      {path:"[].id"},
      {path:"[].node_id"},
      {path:"[].number"},
      {path:"[].state"},
      {path:"[].title"},
      {path:"[].pull_request.url",required:false},
      {path:"[].updated_at"},
    ],
  },
  pull_requests:{
    operation_id:"pulls/list",
    required_permissions:["pull_requests:read"],
    response_slice:[
      {path:"[].id"},
      {path:"[].node_id"},
      {path:"[].number"},
      {path:"[].state"},
      {path:"[].title"},
      {path:"[].user.login",required:false},
      {path:"[].head.sha"},
      {path:"[].base.ref"},
      {path:"[].base.sha"},
      {path:"[].updated_at"},
    ],
  },
  commits:{
    operation_id:"repos/list-commits",
    required_permissions:["contents:read"],
    response_slice:[
      {path:"[].sha"},
      {path:"[].node_id"},
      {path:"[].commit.tree.sha"},
      {path:"[].parents[].sha"},
    ],
  },
  commit:{
    operation_id:"repos/get-commit",
    required_permissions:["contents:read"],
    response_slice:[
      {path:"sha"},
      {path:"node_id"},
      {path:"commit.tree.sha"},
      {path:"parents[].sha"},
    ],
  },
  git_tree:{
    operation_id:"git/get-tree",
    required_permissions:["contents:read"],
    response_slice:[
      {path:"sha"},
      {path:"truncated"},
      {path:"tree[].path"},
      {path:"tree[].mode"},
      {path:"tree[].type"},
      {path:"tree[].sha"},
    ],
  },
  git_blob:{
    operation_id:"git/get-blob",
    required_permissions:["contents:read"],
    response_slice:[
      {path:"sha"},
      {path:"node_id"},
      {path:"size"},
      {path:"encoding"},
      {path:"content"},
    ],
  },
  workflow_runs:{
    operation_id:"actions/list-workflow-runs-for-repo",
    required_permissions:["actions:read"],
    response_slice:[
      {path:"total_count"},
      {path:"workflow_runs[].id"},
      {path:"workflow_runs[].node_id"},
      {path:"workflow_runs[].workflow_id"},
      {path:"workflow_runs[].run_number"},
      {path:"workflow_runs[].run_attempt"},
      {path:"workflow_runs[].status"},
      {path:"workflow_runs[].conclusion"},
      {path:"workflow_runs[].head_sha"},
      {path:"workflow_runs[].head_branch"},
      {path:"workflow_runs[].updated_at"},
    ],
  },
  workflow_jobs:{
    operation_id:"actions/list-jobs-for-workflow-run",
    required_permissions:["actions:read"],
    response_slice:[
      {path:"total_count"},
      {path:"jobs[].id"},
      {path:"jobs[].run_id"},
      {path:"jobs[].run_attempt"},
      {path:"jobs[].node_id"},
      {path:"jobs[].head_sha"},
      {path:"jobs[].name"},
      {path:"jobs[].status"},
      {path:"jobs[].conclusion"},
      {path:"jobs[].started_at"},
      {path:"jobs[].completed_at"},
    ],
  },
  workflow_run_artifacts:{
    operation_id:"actions/list-workflow-run-artifacts",
    required_permissions:["actions:read"],
    response_slice:[
      {path:"total_count"},
      {path:"artifacts[].id"},
      {path:"artifacts[].node_id"},
      {path:"artifacts[].name"},
      {path:"artifacts[].size_in_bytes"},
      {path:"artifacts[].expired"},
      {path:"artifacts[].created_at"},
      {path:"artifacts[].expires_at"},
      {path:"artifacts[].updated_at"},
    ],
  },
  artifact:{
    operation_id:"actions/get-artifact",
    required_permissions:["actions:read"],
    response_slice:[
      {path:"id"},
      {path:"node_id"},
      {path:"name"},
      {path:"size_in_bytes"},
      {path:"expired"},
      {path:"created_at"},
      {path:"expires_at"},
      {path:"updated_at"},
    ],
  },
  workflows:{
    operation_id:"actions/list-repo-workflows",
    required_permissions:["actions:read"],
    response_slice:[
      {path:"total_count"},
      {path:"workflows[].id"},
      {path:"workflows[].node_id"},
      {path:"workflows[].name"},
      {path:"workflows[].path"},
      {path:"workflows[].state"},
      {path:"workflows[].created_at"},
      {path:"workflows[].updated_at"},
    ],
  },
  check_runs_for_ref:{
    operation_id:"checks/list-for-ref",
    required_permissions:["checks:read"],
    response_slice:[
      {path:"total_count"},
      {path:"check_runs[].id"},
      {path:"check_runs[].node_id"},
      {path:"check_runs[].head_sha"},
      {path:"check_runs[].name"},
      {path:"check_runs[].status"},
      {path:"check_runs[].conclusion"},
      {path:"check_runs[].started_at"},
      {path:"check_runs[].completed_at"},
    ],
  },
  check_suites_for_ref:{
    operation_id:"checks/list-suites-for-ref",
    required_permissions:["checks:read"],
    response_slice:[
      {path:"total_count"},
      {path:"check_suites[].id"},
      {path:"check_suites[].node_id"},
      {path:"check_suites[].head_sha"},
      {path:"check_suites[].head_branch"},
      {path:"check_suites[].status"},
      {path:"check_suites[].conclusion"},
      {path:"check_suites[].created_at"},
      {path:"check_suites[].updated_at"},
    ],
  },
  branches:{
    operation_id:"repos/list-branches",
    required_permissions:["contents:read"],
    response_slice:[
      {path:"[].name"},
      {path:"[].commit.sha"},
      {path:"[].protected"},
    ],
  },
  tags:{
    operation_id:"repos/list-tags",
    required_permissions:["contents:read"],
    response_slice:[
      {path:"[].name"},
      {path:"[].commit.sha"},
    ],
  },
  releases:{
    operation_id:"repos/list-releases",
    required_permissions:["contents:read"],
    response_slice:[
      {path:"[].id"},
      {path:"[].node_id"},
      {path:"[].tag_name"},
      {path:"[].target_commitish"},
      {path:"[].draft"},
      {path:"[].prerelease"},
      {path:"[].immutable"},
      {path:"[].published_at"},
      {path:"[].updated_at"},
    ],
  },
  deployments:{
    operation_id:"repos/list-deployments",
    required_permissions:["deployments:read"],
    response_slice:[
      {path:"[].id"},
      {path:"[].node_id"},
      {path:"[].sha"},
      {path:"[].ref"},
      {path:"[].task"},
      {path:"[].environment"},
      {path:"[].created_at"},
      {path:"[].updated_at"},
    ],
  },
  deployment_statuses:{
    operation_id:"repos/list-deployment-statuses",
    required_permissions:["deployments:read"],
    response_slice:[
      {path:"[].id"},
      {path:"[].node_id"},
      {path:"[].state"},
      {path:"[].environment"},
      {path:"[].created_at"},
      {path:"[].updated_at"},
    ],
  },
  commit_pull_requests:{
    operation_id:"repos/list-pull-requests-associated-with-commit",
    required_permissions:["pull_requests:read"],
    response_slice:[
      {path:"[].id"},
      {path:"[].node_id"},
      {path:"[].number"},
      {path:"[].state"},
      {path:"[].head.sha"},
      {path:"[].base.ref"},
      {path:"[].base.sha"},
      {path:"[].updated_at"},
    ],
  },
  check_runs_for_suite:{
    operation_id:"checks/list-for-suite",
    required_permissions:["checks:read"],
    response_slice:[
      {path:"total_count"},
      {path:"check_runs[].id"},
      {path:"check_runs[].node_id"},
      {path:"check_runs[].head_sha"},
      {path:"check_runs[].name"},
      {path:"check_runs[].status"},
      {path:"check_runs[].conclusion"},
      {path:"check_runs[].started_at"},
      {path:"check_runs[].completed_at"},
    ],
  },
} as const satisfies Record<string,GithubSemanticOperation>;

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
