import type { ResponseFieldSpec } from '../provider-observation/response-slice.ts';

export interface GithubSemanticOperation {
  operation_id:string;
  response_slice:readonly ResponseFieldSpec[];
}

export const GITHUB_OPERATION_SEMANTICS={
  repository:{
    operation_id:"repos/get",
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
        "path": "pull_request",
        "required": false
      }
    ],
  },
  check_run:{
    operation_id:"checks/get",
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
