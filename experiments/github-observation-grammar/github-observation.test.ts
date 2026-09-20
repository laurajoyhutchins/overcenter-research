import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveObservationCatalog,
  deriveObservationOperation,
  GitHubRestTransport,
  observeOperation,
  type ObservationOperation,
  type ObservationTransportResponse,
  type OpenApiDocument,
  type RawObservation,
} from './openapi.ts';
import {
  evaluateCheckRunPage,
  evaluateCommitStatusPage,
  evaluateGitRefTarget,
  evaluateIssueSnapshot,
  evaluatePullRequestSnapshot,
  evaluateWorkflowRunPage,
  projectCheckRunsPage,
  projectCommitStatusesPage,
  projectGitCommit,
  projectGitRefTarget,
  projectIssueSnapshot,
  projectPullRequestSnapshot,
  projectRepositoryIdentity,
  projectWorkflowRunsPage,
  revalidateNotModified,
  sameGithubEntity,
} from './semantics.ts';
import { reconstructGithubProjection } from './reconstruction.ts';
import {
  validateObservationSlice,
  validateResponseSlice,
} from '../provider-observation/response-slice.ts';
import { RESPONSE_SLICES } from './response-slices.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SCHEMA_SHA = 'd'.repeat(64);
const RESPONSE = { date: 'Fri, 18 Sep 2026 16:00:00 GMT', etag: null, link: null, request_id: 'REQ:1' };
const provenance = {
  schema_sha256: SCHEMA_SHA,
  observer: { kind: 'test', id: 'unit-test' },
  clock: () => '2026-09-18T16:00:00.000Z',
};

const paths = {
  repo: '/repos/{owner}/{repo}',
  ref: '/repos/{owner}/{repo}/git/ref/{ref}',
  commit: '/repos/{owner}/{repo}/git/commits/{commit_sha}',
  pull: '/repos/{owner}/{repo}/pulls/{pull_number}',
  issue: '/repos/{owner}/{repo}/issues/{issue_number}',
  checks: '/repos/{owner}/{repo}/commits/{ref}/check-runs',
  statuses: '/repos/{owner}/{repo}/commits/{ref}/statuses',
  workflowRuns: '/repos/{owner}/{repo}/actions/runs',
};

const openapi: OpenApiDocument = {
  paths: {
    [paths.repo]: {
      get: {
        operationId: 'repos/get',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'node_id', 'full_name', 'name', 'owner'],
                  properties: {
                    id: { type: 'integer' },
                    node_id: { type: 'string', minLength: 1 },
                    full_name: { type: 'string', minLength: 1 },
                    name: { type: 'string', minLength: 1 },
                    owner: {
                      type: 'object',
                      required: ['login'],
                      properties: {
                        login: { type: 'string', minLength: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
          '301': { description: 'Moved' },
          '404': { description: 'Not found' },
        },
      },
    },
    [paths.ref]: {
      get: {
        operationId: 'git/get-ref',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ref', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'X-Observer-Mode', in: 'header', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ref', 'object'],
                  properties: {
                    ref: { type: 'string' },
                    object: {
                      type: 'object',
                      required: ['type', 'sha'],
                      properties: {
                        type: { type: 'string', enum: ['commit', 'tag'] },
                        sha: { type: 'string', minLength: 40, maxLength: 64 },
                      },
                    },
                  },
                },
              },
            },
          },
          '404': { description: 'Not found' },
        },
      },
      patch: { operationId: 'git/update-ref', responses: { '200': { description: 'Response' } } },
    },
    [paths.commit]: {
      get: {
        operationId: 'git/get-commit',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'commit_sha', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sha', 'node_id', 'tree', 'parents'],
                  properties: {
                    sha: { type: 'string', minLength: 40, maxLength: 64 },
                    node_id: { type: 'string', minLength: 1 },
                    tree: {
                      type: 'object',
                      required: ['sha'],
                      properties: {
                        sha: { type: 'string', minLength: 40, maxLength: 64 },
                      },
                    },
                    parents: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['sha'],
                        properties: {
                          sha: { type: 'string', minLength: 40, maxLength: 64 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '404': { description: 'Not found' },
        },
      },
    },
    [paths.pull]: {
      get: {
        operationId: 'pulls/get',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'pull_number', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'Response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'node_id', 'number', 'state', 'head', 'base'],
                  properties: {
                    id: { type: 'integer' },
                    node_id: { type: 'string', minLength: 1 },
                    number: { type: 'integer' },
                    state: { type: 'string' },
                    head: {
                      type: 'object',
                      required: ['sha'],
                      properties: {
                        sha: { type: 'string', minLength: 40, maxLength: 64 },
                      },
                    },
                    base: {
                      type: 'object',
                      required: ['ref', 'sha'],
                      properties: {
                        ref: { type: 'string' },
                        sha: { type: 'string', minLength: 40, maxLength: 64 },
                      },
                    },
                  },
                },
              },
            },
          },
          '404': { description: 'Not found' },
        },
      },
    },
    [paths.issue]: {
      get: {
        operationId: 'issues/get',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'issue_number', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'Response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'node_id', 'number', 'state', 'title', 'locked', 'updated_at'],
                  properties: {
                    id: { type: 'integer' },
                    node_id: { type: 'string', minLength: 1 },
                    number: { type: 'integer' },
                    state: { type: 'string' },
                    title: { type: 'string' },
                    locked: { type: 'boolean' },
                    state_reason: { type: 'string', nullable: true },
                    updated_at: { type: 'string' },
                    pull_request: {
                      type: 'object',
                      properties: { url: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
          '301': { description: 'Moved' },
          '304': { description: 'Not modified' },
          '404': { description: 'Not found' },
          '410': { description: 'Gone' },
        },
      },
    },
    [paths.checks]: {
      get: {
        operationId: 'checks/list-for-ref',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ref', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'per_page', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'Response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['total_count', 'check_runs'],
                  properties: {
                    total_count: { type: 'integer' },
                    check_runs: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['id', 'node_id', 'name', 'head_sha', 'status', 'conclusion', 'started_at', 'completed_at'],
                        properties: {
                          id: { type: 'integer' },
                          node_id: { type: 'string', minLength: 1 },
                          name: { type: 'string' },
                          head_sha: { type: 'string', minLength: 40, maxLength: 64 },
                          status: { type: 'string' },
                          conclusion: { type: 'string', nullable: true },
                          started_at: { type: 'string' },
                          completed_at: { type: 'string', nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '404': { description: 'Not found' },
        },
      },
    },
    [paths.statuses]: {
      get: {
        operationId: 'repos/list-commit-statuses-for-ref',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ref', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'per_page', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'Response',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['id', 'node_id', 'state', 'context', 'target_url', 'created_at', 'updated_at'],
                    properties: {
                      id: { type: 'integer' },
                      node_id: { type: 'string', minLength: 1 },
                      state: { type: 'string' },
                      context: { type: 'string' },
                      target_url: { type: 'string', nullable: true },
                      created_at: { type: 'string' },
                      updated_at: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          '301': { description: 'Moved' },
        },
      },
    },
    [paths.workflowRuns]: {
      get: {
        operationId: 'actions/list-workflow-runs-for-repo',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'per_page', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'Response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['total_count', 'workflow_runs'],
                  properties: {
                    total_count: { type: 'integer' },
                    workflow_runs: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['id', 'node_id', 'workflow_id', 'run_number', 'run_attempt', 'name', 'event', 'status', 'conclusion', 'head_sha', 'head_branch', 'updated_at'],
                        properties: {
                          id: { type: 'integer' },
                          node_id: { type: 'string', minLength: 1 },
                          workflow_id: { type: 'integer' },
                          run_number: { type: 'integer' },
                          run_attempt: { type: 'integer' },
                          name: { type: 'string' },
                          event: { type: 'string' },
                          status: { type: 'string' },
                          conclusion: { type: 'string', nullable: true },
                          head_sha: { type: 'string', minLength: 40, maxLength: 64 },
                          head_branch: { type: 'string' },
                          updated_at: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

function operation(pathTemplate: string): ObservationOperation {
  return deriveObservationOperation(openapi, { apiVersion: '2026-03-10', method: 'get', pathTemplate });
}

function response(status: number, body?: unknown, metadata = RESPONSE): ObservationTransportResponse {
  return { status, ...(body === undefined ? {} : { body }), response: metadata };
}

async function observe(
  op: ObservationOperation,
  values: Record<string, string | number | boolean>,
  result: ObservationTransportResponse,
  headers?: Record<string, string>,
): Promise<RawObservation> {
  return observeOperation(op, values, { request: async () => result }, provenance, { headers });
}

async function rawRepositoryObservation(owner = 'acme', repo = 'widget', id = 42, fullName = `${owner}/${repo}`): Promise<RawObservation> {
  return observe(operation(paths.repo), { owner, repo }, response(200, {
    id,
    node_id: `R_${id}`,
    name: repo,
    full_name: fullName,
    owner: { login: owner },
  }));
}

async function repositoryObservation(owner = 'acme', repo = 'widget', id = 42, fullName = `${owner}/${repo}`) {
  const repoOperation = operation(paths.repo);
  const observation = await rawRepositoryObservation(owner, repo, id, fullName);
  return validateObservationSlice(
    repoOperation,
    observation,
    RESPONSE_SLICES['repos/get'],
  );
}

test('OpenAPI yields only read operations and auxiliary request headers remain explicit evidence', async () => {
  const descriptor = operation(paths.ref);
  assert.equal(descriptor.operation_id, 'git/get-ref');
  assert.deepEqual(descriptor.parameters.map(p => [p.in, p.name]), [
    ['header', 'X-Observer-Mode'],
    ['path', 'owner'],
    ['path', 'ref'],
    ['path', 'repo'],
  ]);
  assert.equal(deriveObservationCatalog(openapi, '2026-03-10').length, 8);
  assert.throws(() => deriveObservationOperation(openapi, {
    apiVersion: '2026-03-10', method: 'patch', pathTemplate: paths.ref,
  }), /OBSERVATION_OPERATION_MUST_BE_READ_ONLY/);

  const observed = await observeOperation(descriptor, {
    owner: 'acme', repo: 'widget', ref: 'heads/main', 'X-Observer-Mode': 'proof',
  }, {
    request: async input => {
      assert.equal(input.path, '/repos/acme/widget/git/ref/heads%2Fmain');
      assert.equal(input.headers['X-Observer-Mode'], 'proof');
      assert.equal(input.headers['If-None-Match'], '"etag-1"');
      return response(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_A } });
    },
  }, provenance, { headers: { 'If-None-Match': '"etag-1"' } });
  assert.equal(observed.contract.schema_sha256, SCHEMA_SHA);
  assert.equal(observed.observer.id, 'unit-test');
  assert.equal(observed.request.headers['If-None-Match'], '"etag-1"');

  await assert.rejects(
    () => observeOperation(descriptor, { owner: 'acme', repo: 'widget', ref: 'heads/main', invented: 'x' }, {
      request: async () => response(200),
    }, provenance),
    /OBSERVATION_PARAMETER_UNKNOWN:invented/,
  );
});

test('stable repository identity requires structural certification and survives owner/name alias changes', async () => {
  const raw = await rawRepositoryObservation('acme', 'widget', 42);
  assert.equal(projectRepositoryIdentity(raw), null);

  const before = projectRepositoryIdentity(await repositoryObservation('acme', 'widget', 42));
  const after = projectRepositoryIdentity(await repositoryObservation('new-acme', 'renamed-widget', 42));
  assert.ok(before && after);
  assert.equal(before.subject.id, after.subject.id);
  assert.notEqual(before.object.full_name, after.object.full_name);
  assert.equal(before.stability, 'stable-subject-mutable-alias');
});

test('ref binding composes through stable repository identity and 404 never proves absence', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const refOperation = operation(paths.ref);
  const refObservation = await observe(refOperation, {
    owner: 'acme', repo: 'widget', ref: 'heads/main',
  }, response(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_A } }));

  assert.equal(projectGitRefTarget(refObservation, repository), null);
  assert.equal(evaluateGitRefTarget(refObservation, repository, {
    repository_id: 42, ref: 'heads/main', target_sha: SHA_A,
  }).reason, 'OBSERVATION_DOES_NOT_PROVE_REF_BINDING');

  const validatedRef = validateObservationSlice(
    refOperation,
    refObservation,
    RESPONSE_SLICES['git/get-ref'],
  );
  const fact = projectGitRefTarget(validatedRef, repository)!;
  assert.equal(fact.subject.repository_id, 42);
  assert.equal(fact.object.sha, SHA_A);
  assert.equal(evaluateGitRefTarget(validatedRef, repository, {
    repository_id: 42, ref: 'heads/main', target_sha: SHA_A,
  }).state, 'SATISFIED');
  assert.equal(evaluateGitRefTarget(validatedRef, repository, {
    repository_id: 42, ref: 'heads/main', target_sha: SHA_B,
  }).state, 'UNSATISFIED');

  const missing = await observe(operation(paths.ref), {
    owner: 'acme', repo: 'widget', ref: 'heads/missing',
  }, response(404, { message: 'Not Found' }));
  assert.deepEqual(evaluateGitRefTarget(missing, repository, {
    repository_id: 42, ref: 'heads/missing', target_sha: SHA_A,
  }), { state: 'INDETERMINATE', reason: 'NOT_VISIBLE_IS_NOT_ABSENCE' });
});

test('immutable commit projection requires structural certification and exact request identity', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const commitOperation = operation(paths.commit);
  const commit = await observe(commitOperation, {
    owner: 'acme', repo: 'widget', commit_sha: SHA_A,
  }, response(200, {
    sha: SHA_A,
    node_id: 'COMMIT_A',
    tree: { sha: SHA_B },
    parents: [{ sha: SHA_C }],
  }));

  assert.equal(projectGitCommit(commit, repository), null);
  const validatedCommit = validateObservationSlice(
    commitOperation,
    commit,
    RESPONSE_SLICES['git/get-commit'],
  );
  const fact = projectGitCommit(validatedCommit, repository)!;
  assert.equal(fact.subject.repository_id, 42);
  assert.equal(fact.subject.sha, SHA_A);
  assert.equal(fact.tree_sha, SHA_B);
  assert.equal(fact.stability, 'content-addressed');

  const mismatched = await observe(commitOperation, {
    owner: 'acme', repo: 'widget', commit_sha: SHA_A,
  }, response(200, { sha: SHA_B, node_id: 'COMMIT_B', tree: { sha: SHA_C }, parents: [] }));
  const validatedMismatch = validateObservationSlice(
    commitOperation,
    mismatched,
    RESPONSE_SLICES['git/get-commit'],
  );
  assert.equal(projectGitCommit(validatedMismatch, repository), null);
});

test('pull request is a mutable snapshot rather than an internal state machine', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const pull = await observe(operation(paths.pull), {
    owner: 'acme', repo: 'widget', pull_number: 17,
  }, response(200, {
    id: 1700,
    node_id: 'NODE_PR_17',
    number: 17,
    state: 'open',
    head: { sha: SHA_A },
    base: { ref: 'main', sha: SHA_B },
  }));
  assert.equal(projectPullRequestSnapshot(pull, repository), null);
  const fact = projectPullRequestSnapshot(validateObservationSlice(
    operation(paths.pull),
    pull,
    RESPONSE_SLICES['pulls/get'],
  ), repository)!;
  assert.equal(fact.stability, 'mutable-snapshot');
  assert.equal(evaluatePullRequestSnapshot(fact, {
    repository_id: 42, number: 17, state: 'open', head_sha: SHA_A, base_ref: 'main',
  }).state, 'SATISFIED');
  assert.equal(evaluatePullRequestSnapshot(fact, {
    repository_id: 42, number: 17, state: 'closed',
  }).state, 'UNSATISFIED');
});

test('Pulls and Issues surfaces preserve cross-surface node identity without conflating numeric ids', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const pull = await observe(operation(paths.pull), {
    owner: 'acme', repo: 'widget', pull_number: 17,
  }, response(200, {
    id: 1700,
    node_id: 'NODE_SHARED_17',
    number: 17,
    state: 'open',
    head: { sha: SHA_A },
    base: { ref: 'main', sha: SHA_B },
  }));
  const issue = await observe(operation(paths.issue), {
    owner: 'acme', repo: 'widget', issue_number: 17,
  }, response(200, {
    id: 9900,
    node_id: 'NODE_SHARED_17',
    number: 17,
    state: 'open',
    title: 'Same logical PR through Issues surface',
    locked: false,
    updated_at: '2026-09-18T16:00:00Z',
    pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/17' },
  }));

  const pullFact = projectPullRequestSnapshot(validateObservationSlice(
    operation(paths.pull),
    pull,
    RESPONSE_SLICES['pulls/get'],
  ), repository)!;
  const issueFact = projectIssueSnapshot(validateObservationSlice(
    operation(paths.issue),
    issue,
    RESPONSE_SLICES['issues/get'],
  ), repository)!;
  assert.notEqual(pullFact.subject.id, issueFact.subject.id);
  assert.equal(pullFact.subject.node_id, issueFact.subject.node_id);
  assert.equal(sameGithubEntity(pullFact, issueFact), true);
  assert.equal(issueFact.is_pull_request, true);
  assert.equal(evaluateIssueSnapshot(issueFact, {
    repository_id: 42,
    number: 17,
    state: 'open',
    title: 'Same logical PR through Issues surface',
  }).state, 'SATISFIED');

  const rebuilt = reconstructGithubProjection({
    durable: [repository],
    current: [pullFact, issueFact],
  });
  assert.equal(rebuilt.pull_requests['42:17'].subject.kind, 'github.pull-request');
  assert.equal(rebuilt.issues['42:17'].subject.kind, 'github.issue');
  const entity = rebuilt.entities['42:NODE_SHARED_17'];
  assert.equal(entity.pull_request?.subject.id, 1700);
  assert.equal(entity.issue?.subject.id, 9900);
});

test('paginated collection proves positive membership but not absence, even on a terminal page', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const first = await observe(operation(paths.checks), {
    owner: 'acme', repo: 'widget', ref: SHA_A, page: 1, per_page: 1,
  }, response(200, {
    total_count: 2,
    check_runs: [{ id: 10, node_id: 'CHECK_10', name: 'build', head_sha: SHA_A, status: 'completed', conclusion: 'success', started_at: '2026-09-18T16:00:00Z', completed_at: '2026-09-18T16:01:00Z' }],
  }, { ...RESPONSE, link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=2>; rel="last"' }));
  assert.equal(projectCheckRunsPage(first, repository), null);
  const firstPage = projectCheckRunsPage(validateObservationSlice(
    operation(paths.checks),
    first,
    RESPONSE_SLICES['checks/list-for-ref'],
  ), repository)!;
  assert.equal(firstPage.has_next, true);
  assert.equal(firstPage.enumeration, 'partial');
  assert.equal(evaluateCheckRunPage(firstPage, {
    repository_id: 42, ref: SHA_A, id: 10, conclusion: 'success',
  }).state, 'SATISFIED');
  assert.deepEqual(evaluateCheckRunPage(firstPage, {
    repository_id: 42, ref: SHA_A, id: 99,
  }).state, 'INDETERMINATE');

  const terminal = await observe(operation(paths.checks), {
    owner: 'acme', repo: 'widget', ref: SHA_A, page: 2, per_page: 1,
  }, response(200, {
    total_count: 2,
    check_runs: [{ id: 11, node_id: 'CHECK_11', name: 'lint', head_sha: SHA_A, status: 'completed', conclusion: 'success', started_at: '2026-09-18T16:00:00Z', completed_at: '2026-09-18T16:01:00Z' }],
  }, { ...RESPONSE, link: '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=1>; rel="first"' }));
  const terminalPage = projectCheckRunsPage(validateObservationSlice(
    operation(paths.checks),
    terminal,
    RESPONSE_SLICES['checks/list-for-ref'],
  ), repository)!;
  assert.equal(terminalPage.enumeration, 'terminal-page-seen');
  assert.equal(terminalPage.negative_evidence_authoritative, false);
  assert.equal(evaluateCheckRunPage(terminalPage, {
    repository_id: 42, ref: SHA_A, id: 99,
  }).reason, 'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');
});

test('an empty check-run page is observation evidence, not proof that no run exists', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const empty = await observe(operation(paths.checks), {
    owner: 'acme', repo: 'widget', ref: SHA_A, page: 1, per_page: 1,
  }, response(200, {
    total_count: 0,
    check_runs: [],
  }));
  const page = projectCheckRunsPage(validateObservationSlice(
    operation(paths.checks),
    empty,
    RESPONSE_SLICES['checks/list-for-ref'],
  ), repository)!;
  assert.equal(page.members.length, 0);
  assert.equal(page.total_count, 0);
  assert.equal(page.negative_evidence_authoritative, false);
  assert.deepEqual(evaluateCheckRunPage(page, {
    repository_id: 42,
    ref: SHA_A,
    id: 123,
  }).state, 'INDETERMINATE');
});

test('commit statuses reuse positive collection membership semantics without gaining authoritative absence', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const observed = await observe(operation(paths.statuses), {
    owner: 'acme', repo: 'widget', ref: SHA_A, page: 1, per_page: 1,
  }, response(200, [{
    id: 501,
    node_id: 'STATUS_501',
    state: 'success',
    context: 'overcenter/proof',
    target_url: null,
    created_at: '2026-09-18T16:00:00Z',
    updated_at: '2026-09-18T16:01:00Z',
  }], { ...RESPONSE, link: '<https://api.github.com/x?page=2>; rel="next"' }));

  assert.equal(projectCommitStatusesPage(observed, repository), null);
  const page = projectCommitStatusesPage(validateObservationSlice(
    operation(paths.statuses),
    observed,
    RESPONSE_SLICES['repos/list-commit-statuses-for-ref'],
  ), repository)!;
  assert.equal(page.has_next, true);
  assert.equal(evaluateCommitStatusPage(page, {
    repository_id: 42,
    ref: SHA_A,
    node_id: 'STATUS_501',
    context: 'overcenter/proof',
    state: 'success',
  }).state, 'SATISFIED');
  assert.equal(evaluateCommitStatusPage(page, {
    repository_id: 42,
    ref: SHA_A,
    node_id: 'MISSING',
  }).reason, 'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');
});

test('workflow runs reuse collection membership semantics with a repository-scoped coordinate', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const observed = await observe(operation(paths.workflowRuns), {
    owner: 'acme', repo: 'widget', page: 1, per_page: 1,
  }, response(200, {
    total_count: 2,
    workflow_runs: [{
      id: 7001,
      node_id: 'WFR_7001',
      workflow_id: 88,
      run_number: 12,
      run_attempt: 1,
      name: 'Tests',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      head_sha: SHA_A,
      head_branch: 'main',
      updated_at: '2026-09-18T16:01:00Z',
    }],
  }, { ...RESPONSE, link: '<https://api.github.com/x?page=2>; rel="next"' }));

  assert.equal(projectWorkflowRunsPage(observed, repository), null);
  const page = projectWorkflowRunsPage(validateObservationSlice(
    operation(paths.workflowRuns),
    observed,
    RESPONSE_SLICES['actions/list-workflow-runs-for-repo'],
  ), repository)!;
  assert.equal(page.subject.repository_id, 42);
  assert.equal(page.has_next, true);
  assert.equal(evaluateWorkflowRunPage(page, {
    repository_id: 42,
    node_id: 'WFR_7001',
    workflow_id: 88,
    head_sha: SHA_A,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  }).state, 'SATISFIED');
  assert.equal(evaluateWorkflowRunPage(page, {
    repository_id: 42,
    node_id: 'MISSING',
  }).reason, 'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');
});

test('304 revalidates prior representation only when ETag, coordinate, and contract identity match', async () => {
  const prior = await observe(operation(paths.repo), { owner: 'acme', repo: 'widget' }, response(200, {
    id: 42, node_id: 'R_42', name: 'widget', full_name: 'acme/widget', owner: { login: 'acme' },
  }, { ...RESPONSE, etag: '"repo-etag"' }));
  const current = await observe(operation(paths.repo), { owner: 'acme', repo: 'widget' }, response(304, undefined, {
    ...RESPONSE,
    etag: '"repo-etag"',
    date: 'Fri, 18 Sep 2026 16:05:00 GMT',
  }), { 'If-None-Match': '"repo-etag"' });
  const revalidated = revalidateNotModified(prior, current);
  assert.ok(revalidated);
  assert.deepEqual(revalidated.outcome.value, prior.outcome.value);
  assert.equal(revalidated.revalidated_from.etag, '"repo-etag"');

  const wrong = structuredClone(current);
  wrong.request.headers['If-None-Match'] = '"other"';
  assert.equal(revalidateNotModified(prior, wrong), null);
});

test('GitHub REST transport records non-secret wire headers, auth class, response identity, and redirects', async () => {
  const calls: Array<{ url: string; init: { method: 'GET' | 'HEAD'; headers: Record<string, string>; redirect: 'manual' } }> = [];
  const transport = new GitHubRestTransport({
    token: 'secret-token',
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return {
        status: 301,
        headers: {
          get: name => ({
            location: 'https://api.github.com/repositories/42',
            date: RESPONSE.date,
            etag: '"e"',
            'x-github-request-id': 'REQ:2',
          } as Record<string, string>)[name.toLowerCase()] ?? null,
        },
        text: async () => '',
      };
    },
  });
  const observed = await observeOperation(operation(paths.repo), { owner: 'acme', repo: 'widget' }, transport, provenance);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(observed.request.authorization, 'bearer');
  assert.equal(observed.request.headers.Authorization, undefined);
  assert.equal(observed.request.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(observed.response.request_id, 'REQ:2');
  assert.deepEqual(observed.outcome.redirect, { location: 'https://api.github.com/repositories/42' });
  assert.equal(observed.outcome.visibility, 'indeterminate');
});

test('reconstruction reuses immutable facts but requires fresh authority for mutable state', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const commitOperation = operation(paths.commit);
  const commitObservation = await observe(commitOperation, {
    owner: 'acme', repo: 'widget', commit_sha: SHA_A,
  }, response(200, { sha: SHA_A, node_id: 'COMMIT_RECONSTRUCT', tree: { sha: SHA_B }, parents: [] }));
  const commit = projectGitCommit(validateObservationSlice(
    commitOperation,
    commitObservation,
    RESPONSE_SLICES['git/get-commit'],
  ), repository)!;

  const refOperation = operation(paths.ref);
  const oldRefObservation = await observe(refOperation, {
    owner: 'acme', repo: 'widget', ref: 'heads/main',
  }, response(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_A } }));
  const oldRef = projectGitRefTarget(validateObservationSlice(
    refOperation,
    oldRefObservation,
    RESPONSE_SLICES['git/get-ref'],
  ), repository)!;

  const freshRefObservation = await observe(refOperation, {
    owner: 'acme', repo: 'widget', ref: 'heads/main',
  }, response(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_B } }));
  const freshRef = projectGitRefTarget(validateObservationSlice(
    refOperation,
    freshRefObservation,
    RESPONSE_SLICES['git/get-ref'],
  ), repository)!;

  const withoutFresh = reconstructGithubProjection({ durable: [repository, commit, oldRef], current: [] });
  assert.equal(Object.keys(withoutFresh.commits).length, 1);
  assert.equal(Object.keys(withoutFresh.refs).length, 0);

  const rebuilt = reconstructGithubProjection({
    durable: JSON.parse(JSON.stringify([repository, commit, oldRef])),
    current: JSON.parse(JSON.stringify([repository, freshRef])),
  });
  assert.equal(Object.keys(rebuilt.commits).length, 1);
  assert.equal(rebuilt.refs['42:refs/heads/main'].object.sha, SHA_B);
});


test('reserved transport headers cannot be spoofed by operation parameters', async () => {
  const transport = new GitHubRestTransport({
    fetchFn: async () => {
      throw new Error('must not reach fetch');
    },
  });
  await assert.rejects(
    () => transport.request({
      method: 'GET',
      path: '/repos/acme/widget',
      headers: { 'X-GitHub-Api-Version': '1900-01-01' },
      apiVersion: '2026-03-10',
    }),
    /GITHUB_OBSERVATION_HEADER_RESERVED:X-GitHub-Api-Version/,
  );
});


test('semantic response slice rejects structural mismatches without validating unrelated response fields', () => {
  const document: OpenApiDocument = {
    paths: {
      '/example': {
        get: {
          operationId: 'example/get',
          responses: {
            '200': {
              description: 'Response',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'members'],
                    properties: {
                      id: { type: 'integer' },
                      ignored: {
                        type: 'object',
                        required: ['huge', 'irrelevant'],
                        properties: {
                          huge: { type: 'string' },
                          irrelevant: { type: 'string' },
                        },
                      },
                      optional_note: { type: 'string', nullable: true },
                      members: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['sha'],
                          properties: {
                            sha: { type: 'string', minLength: 40, maxLength: 64 },
                            ignored_member_field: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const operation = deriveObservationOperation(document, {
    apiVersion: '2026-03-10',
    method: 'get',
    pathTemplate: '/example',
  });

  const valid = validateResponseSlice(operation, '200', {
    id: 7,
    ignored: {},
    members: [{ sha: SHA_A, ignored_member_field: 123 }],
  }, [
    { path: 'id' },
    { path: 'members[].sha' },
    { path: 'optional_note', required: false },
  ]);
  assert.deepEqual(valid.validated_paths, ['id', 'members[].sha']);
  assert.deepEqual(valid.optional_absent_paths, ['optional_note']);

  assert.throws(() => validateResponseSlice(operation, '200', {
    id: '7',
    members: [{ sha: SHA_A }],
  }, [{ path: 'id' }]), /RESPONSE_SLICE_VALUE_MISMATCH:id/);

  assert.throws(() => validateResponseSlice(operation, '200', {
    id: 7,
    members: [{}],
  }, [{ path: 'members[].sha' }]), /RESPONSE_SLICE_REQUIRED_FIELD_MISSING:members\[\]\.sha/);

  assert.throws(() => validateResponseSlice(operation, '200', {
    id: 7,
    members: [],
  }, [{ path: 'does_not_exist' }]), /RESPONSE_SLICE_SCHEMA_PATH_NOT_FOUND:does_not_exist/);
});
