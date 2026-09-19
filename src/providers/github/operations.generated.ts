// GENERATED FILE. DO NOT EDIT.
// Source: github/rest-api-description@d4278c869e367f5d6d4e0f46878119128abba77b
// SHA-256: 9d0534e66064a95f0637d542b463a868fc60a53a8cac37eddc85d72a465b8810
import type { GithubObservationOperation } from './openapi.ts';

export const GITHUB_REPOSITORY_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}",
  "operation_id": "repos/get",
  "parameters": [
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "format": "int64"
          },
          "node_id": {
            "type": "string"
          },
          "full_name": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "owner": {
            "type": "object",
            "properties": {
              "login": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "repos",
    "subcategory": "repos"
  }
};

export const GITHUB_REF_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/git/ref/{ref}",
  "operation_id": "git/get-ref",
  "parameters": [
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "ref",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "ref": {
            "type": "string"
          },
          "object": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string"
              },
              "sha": {
                "type": "string",
                "minLength": 40,
                "maxLength": 40
              }
            }
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "git",
    "subcategory": "refs"
  }
};

export const GITHUB_GIT_COMMIT_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/git/commits/{commit_sha}",
  "operation_id": "git/get-commit",
  "parameters": [
    {
      "name": "commit_sha",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "sha": {
            "type": "string"
          },
          "node_id": {
            "type": "string"
          },
          "tree": {
            "type": "object",
            "properties": {
              "sha": {
                "type": "string"
              }
            }
          },
          "parents": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "sha": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "git",
    "subcategory": "commits"
  }
};

export const GITHUB_BRANCH_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/branches/{branch}",
  "operation_id": "repos/get-branch",
  "parameters": [
    {
      "name": "branch",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "commit": {
            "type": "object",
            "properties": {
              "sha": {
                "type": "string"
              }
            }
          },
          "protected": {
            "type": "boolean"
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "branches",
    "subcategory": "branches"
  }
};

export const GITHUB_PULL_REQUEST_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/pulls/{pull_number}",
  "operation_id": "pulls/get",
  "parameters": [
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "pull_number",
      "in": "path",
      "required": true,
      "schema": {
        "type": "integer"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Pass the appropriate [media type](https://docs.github.com/rest/using-the-rest-api/getting-started-with-the-rest-api#media-types) to fetch diff and patch formats.",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "format": "int64"
          },
          "node_id": {
            "type": "string"
          },
          "number": {
            "type": "integer"
          },
          "state": {
            "type": "string",
            "enum": [
              "open",
              "closed"
            ]
          },
          "head": {
            "type": "object",
            "properties": {
              "sha": {
                "type": "string"
              }
            }
          },
          "base": {
            "type": "object",
            "properties": {
              "ref": {
                "type": "string"
              },
              "sha": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "pulls",
    "subcategory": "pulls"
  }
};

export const GITHUB_ISSUE_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/issues/{issue_number}",
  "operation_id": "issues/get",
  "parameters": [
    {
      "name": "issue_number",
      "in": "path",
      "required": true,
      "schema": {
        "type": "integer"
      }
    },
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "format": "int64"
          },
          "node_id": {
            "type": "string"
          },
          "number": {
            "type": "integer"
          },
          "state": {
            "type": "string"
          },
          "state_reason": {
            "type": "string",
            "enum": [
              "completed",
              "reopened",
              "not_planned",
              "duplicate"
            ],
            "nullable": true
          },
          "title": {
            "type": "string"
          },
          "locked": {
            "type": "boolean"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          },
          "pull_request": {
            "type": "object"
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "issues",
    "subcategory": "issues"
  }
};

export const GITHUB_CHECK_RUN_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/check-runs/{check_run_id}",
  "operation_id": "checks/get",
  "parameters": [
    {
      "name": "check_run_id",
      "in": "path",
      "required": true,
      "schema": {
        "type": "integer",
        "format": "int64"
      }
    },
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "format": "int64"
          },
          "node_id": {
            "type": "string"
          },
          "head_sha": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "queued",
              "in_progress",
              "completed",
              "waiting",
              "requested",
              "pending"
            ]
          },
          "conclusion": {
            "type": "string",
            "enum": [
              "success",
              "failure",
              "neutral",
              "cancelled",
              "skipped",
              "timed_out",
              "action_required"
            ],
            "nullable": true
          },
          "started_at": {
            "type": "string",
            "nullable": true,
            "format": "date-time"
          },
          "completed_at": {
            "type": "string",
            "nullable": true,
            "format": "date-time"
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "checks",
    "subcategory": "runs"
  }
};

export const GITHUB_CHECK_SUITE_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/check-suites/{check_suite_id}",
  "operation_id": "checks/get-suite",
  "parameters": [
    {
      "name": "check_suite_id",
      "in": "path",
      "required": true,
      "schema": {
        "type": "integer"
      }
    },
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "format": "int64"
          },
          "node_id": {
            "type": "string"
          },
          "head_sha": {
            "type": "string"
          },
          "head_branch": {
            "type": "string",
            "nullable": true
          },
          "status": {
            "type": "string",
            "enum": [
              "queued",
              "in_progress",
              "completed",
              "waiting",
              "requested",
              "pending"
            ],
            "nullable": true
          },
          "conclusion": {
            "type": "string",
            "enum": [
              "success",
              "failure",
              "neutral",
              "cancelled",
              "skipped",
              "timed_out",
              "action_required",
              "startup_failure",
              "stale",
              null
            ],
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "nullable": true,
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "nullable": true,
            "format": "date-time"
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "checks",
    "subcategory": "suites"
  }
};

export const GITHUB_COMMIT_STATUSES_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/commits/{ref}/statuses",
  "operation_id": "repos/list-commit-statuses-for-ref",
  "parameters": [
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "ref",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "page",
      "in": "query",
      "required": false,
      "schema": {
        "type": "integer",
        "default": 1
      }
    },
    {
      "name": "per_page",
      "in": "query",
      "required": false,
      "schema": {
        "type": "integer",
        "default": 30
      }
    }
  ],
  "pagination": {
    "kind": "page-number",
    "page_parameter": "page",
    "page_size_parameter": "per_page",
    "first_page": 1,
    "default_page_size": 30
  },
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "integer"
            },
            "node_id": {
              "type": "string"
            },
            "state": {
              "type": "string"
            },
            "context": {
              "type": "string"
            },
            "target_url": {
              "type": "string",
              "nullable": true
            },
            "created_at": {
              "type": "string"
            },
            "updated_at": {
              "type": "string"
            }
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "commits",
    "subcategory": "statuses"
  }
};

export const GITHUB_COMBINED_COMMIT_STATUS_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/commits/{ref}/status",
  "operation_id": "repos/get-combined-status-for-ref",
  "parameters": [
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "ref",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "page",
      "in": "query",
      "required": false,
      "schema": {
        "type": "integer",
        "default": 1
      }
    },
    {
      "name": "per_page",
      "in": "query",
      "required": false,
      "schema": {
        "type": "integer",
        "default": 30
      }
    }
  ],
  "pagination": {
    "kind": "page-number",
    "page_parameter": "page",
    "page_size_parameter": "per_page",
    "first_page": 1,
    "default_page_size": 30
  },
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "state": {
            "type": "string"
          },
          "sha": {
            "type": "string"
          },
          "total_count": {
            "type": "integer"
          },
          "statuses": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "integer"
                },
                "node_id": {
                  "type": "string"
                },
                "state": {
                  "type": "string"
                },
                "context": {
                  "type": "string"
                },
                "target_url": {
                  "type": "string",
                  "nullable": true,
                  "format": "uri"
                },
                "created_at": {
                  "type": "string",
                  "format": "date-time"
                },
                "updated_at": {
                  "type": "string",
                  "format": "date-time"
                }
              }
            }
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "commits",
    "subcategory": "statuses"
  }
};

export const GITHUB_WORKFLOW_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/actions/workflows/{workflow_id}",
  "operation_id": "actions/get-workflow",
  "parameters": [
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "workflow_id",
      "in": "path",
      "required": true,
      "schema": {
        "oneOf": [
          {
            "type": "integer"
          },
          {
            "type": "string"
          }
        ]
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer"
          },
          "node_id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "path": {
            "type": "string"
          },
          "state": {
            "type": "string",
            "enum": [
              "active",
              "deleted",
              "disabled_fork",
              "disabled_inactivity",
              "disabled_manually"
            ]
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "actions",
    "subcategory": "workflows"
  }
};

export const GITHUB_WORKFLOW_RUN_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/actions/runs/{run_id}",
  "operation_id": "actions/get-workflow-run",
  "parameters": [
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "run_id",
      "in": "path",
      "required": true,
      "schema": {
        "type": "integer"
      }
    },
    {
      "name": "exclude_pull_requests",
      "in": "query",
      "required": false,
      "schema": {
        "type": "boolean",
        "default": false
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "format": "int64"
          },
          "node_id": {
            "type": "string"
          },
          "workflow_id": {
            "type": "integer"
          },
          "run_number": {
            "type": "integer"
          },
          "run_attempt": {
            "type": "integer"
          },
          "name": {
            "type": "string",
            "nullable": true
          },
          "event": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "nullable": true
          },
          "conclusion": {
            "type": "string",
            "nullable": true
          },
          "head_sha": {
            "type": "string"
          },
          "head_branch": {
            "type": "string",
            "nullable": true
          },
          "path": {
            "type": "string"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "actions",
    "subcategory": "workflow-runs"
  }
};

export const GITHUB_WORKFLOW_JOB_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/actions/jobs/{job_id}",
  "operation_id": "actions/get-job-for-workflow-run",
  "parameters": [
    {
      "name": "job_id",
      "in": "path",
      "required": true,
      "schema": {
        "type": "integer",
        "format": "int64"
      }
    },
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "format": "int64"
          },
          "run_id": {
            "type": "integer",
            "format": "int64"
          },
          "run_attempt": {
            "type": "integer"
          },
          "node_id": {
            "type": "string"
          },
          "head_sha": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "queued",
              "in_progress",
              "completed",
              "waiting",
              "requested",
              "pending"
            ]
          },
          "conclusion": {
            "type": "string",
            "enum": [
              "success",
              "failure",
              "neutral",
              "cancelled",
              "skipped",
              "timed_out",
              "action_required"
            ],
            "nullable": true
          },
          "started_at": {
            "type": "string",
            "format": "date-time"
          },
          "completed_at": {
            "type": "string",
            "nullable": true,
            "format": "date-time"
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "actions",
    "subcategory": "workflow-jobs"
  }
};

export const GITHUB_RELEASE_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/releases/{release_id}",
  "operation_id": "repos/get-release",
  "parameters": [
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "release_id",
      "in": "path",
      "required": true,
      "schema": {
        "type": "integer"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "**Note:** This returns an `upload_url` key corresponding to the endpoint for uploading release assets. This key is a hypermedia resource. For more information, see \"[Getting started with the REST API](https://docs.github.com/rest/using-the-rest-api/getting-started-with-the-rest-api#hypermedia).\"",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer"
          },
          "node_id": {
            "type": "string"
          },
          "tag_name": {
            "type": "string"
          },
          "target_commitish": {
            "type": "string"
          },
          "name": {
            "type": "string",
            "nullable": true
          },
          "draft": {
            "type": "boolean"
          },
          "prerelease": {
            "type": "boolean"
          },
          "immutable": {
            "type": "boolean"
          },
          "published_at": {
            "type": "string",
            "nullable": true,
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "nullable": true,
            "format": "date-time"
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "releases",
    "subcategory": "releases"
  }
};

export const GITHUB_RELEASE_ASSET_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/releases/assets/{asset_id}",
  "operation_id": "repos/get-release-asset",
  "parameters": [
    {
      "name": "asset_id",
      "in": "path",
      "required": true,
      "schema": {
        "type": "integer"
      }
    },
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer"
          },
          "node_id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "state": {
            "type": "string",
            "enum": [
              "uploaded",
              "open"
            ]
          },
          "content_type": {
            "type": "string"
          },
          "size": {
            "type": "integer"
          },
          "digest": {
            "type": "string",
            "nullable": true
          },
          "download_count": {
            "type": "integer"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "releases",
    "subcategory": "assets"
  }
};

export const GITHUB_DEPLOYMENT_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/deployments/{deployment_id}",
  "operation_id": "repos/get-deployment",
  "parameters": [
    {
      "name": "deployment_id",
      "in": "path",
      "required": true,
      "schema": {
        "type": "integer"
      }
    },
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "format": "int64"
          },
          "node_id": {
            "type": "string"
          },
          "sha": {
            "type": "string"
          },
          "ref": {
            "type": "string"
          },
          "task": {
            "type": "string"
          },
          "environment": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "nullable": true
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "deployments",
    "subcategory": "deployments"
  }
};

export const GITHUB_DEPLOYMENT_STATUS_OPERATION:GithubObservationOperation={
  "provider": "github",
  "api_version": "2026-03-10",
  "method": "GET",
  "path_template": "/repos/{owner}/{repo}/deployments/{deployment_id}/statuses/{status_id}",
  "operation_id": "repos/get-deployment-status",
  "parameters": [
    {
      "name": "deployment_id",
      "in": "path",
      "required": true,
      "schema": {
        "type": "integer"
      }
    },
    {
      "name": "owner",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "repo",
      "in": "path",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "status_id",
      "in": "path",
      "required": true,
      "schema": {
        "type": "integer"
      }
    }
  ],
  "outcomes": [
    {
      "status": "200",
      "description": "Response",
      "schema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "format": "int64"
          },
          "node_id": {
            "type": "string"
          },
          "state": {
            "type": "string",
            "enum": [
              "error",
              "failure",
              "inactive",
              "pending",
              "success",
              "queued",
              "in_progress"
            ]
          },
          "environment": {
            "type": "string"
          },
          "description": {
            "type": "string",
            "maxLength": 140
          },
          "target_url": {
            "type": "string",
            "format": "uri"
          },
          "created_at": {
            "type": "string",
            "format": "date-time"
          },
          "updated_at": {
            "type": "string",
            "format": "date-time"
          }
        }
      }
    }
  ],
  "github_extensions": {
    "githubCloudOnly": false,
    "enabledForGitHubApps": true,
    "category": "deployments",
    "subcategory": "statuses"
  }
};

export const GITHUB_OBSERVATION_OPERATIONS={
  repository:GITHUB_REPOSITORY_OPERATION,
  ref:GITHUB_REF_OPERATION,
  git_commit:GITHUB_GIT_COMMIT_OPERATION,
  branch:GITHUB_BRANCH_OPERATION,
  pull_request:GITHUB_PULL_REQUEST_OPERATION,
  issue:GITHUB_ISSUE_OPERATION,
  check_run:GITHUB_CHECK_RUN_OPERATION,
  check_suite:GITHUB_CHECK_SUITE_OPERATION,
  commit_statuses:GITHUB_COMMIT_STATUSES_OPERATION,
  combined_commit_status:GITHUB_COMBINED_COMMIT_STATUS_OPERATION,
  workflow:GITHUB_WORKFLOW_OPERATION,
  workflow_run:GITHUB_WORKFLOW_RUN_OPERATION,
  workflow_job:GITHUB_WORKFLOW_JOB_OPERATION,
  release:GITHUB_RELEASE_OPERATION,
  release_asset:GITHUB_RELEASE_ASSET_OPERATION,
  deployment:GITHUB_DEPLOYMENT_OPERATION,
  deployment_status:GITHUB_DEPLOYMENT_STATUS_OPERATION,
} as const;
