// GENERATED FILE. DO NOT EDIT.
// Source: github/rest-api-description@d4278c869e367f5d6d4e0f46878119128abba77b
// SHA-256: 9d0534e66064a95f0637d542b463a868fc60a53a8cac37eddc85d72a465b8810
import type { GithubObservationOperation } from './github-openapi.ts';

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
