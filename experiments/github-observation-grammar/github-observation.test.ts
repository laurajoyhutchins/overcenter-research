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
  evaluateGitRefTarget,
  evaluatePullRequestSnapshot,
  projectCheckRunsPage,
  projectGitCommit,
  projectGitRefTarget,
  projectPullRequestSnapshot,
  projectRepositoryIdentity,
  revalidateNotModified,
} from './semantics.ts';
import { reconstructGithubProjection } from './reconstruction.ts';

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
  checks: '/repos/{owner}/{repo}/commits/{ref}/check-runs',
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
        responses: { '200': { description: 'Response' }, '301': { description: 'Moved' }, '404': { description: 'Not found' } },
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
        responses: { '200': { description: 'Response' }, '404': { description: 'Not found' } },
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
        responses: { '200': { description: 'Response' }, '404': { description: 'Not found' } },
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
        responses: { '200': { description: 'Response' }, '404': { description: 'Not found' } },
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
        responses: { '200': { description: 'Response' }, '404': { description: 'Not found' } },
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

async function repositoryObservation(owner = 'acme', repo = 'widget', id = 42, fullName = `${owner}/${repo}`): Promise<RawObservation> {
  return observe(operation(paths.repo), { owner, repo }, response(200, {
    id,
    node_id: `R_${id}`,
    name: repo,
    full_name: fullName,
    owner: { login: owner },
  }));
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
  assert.equal(deriveObservationCatalog(openapi, '2026-03-10').length, 5);
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

test('stable repository identity is numeric even when the observed owner/name alias changes', async () => {
  const before = projectRepositoryIdentity(await repositoryObservation('acme', 'widget', 42));
  const after = projectRepositoryIdentity(await repositoryObservation('new-acme', 'renamed-widget', 42));
  assert.ok(before && after);
  assert.equal(before.subject.id, after.subject.id);
  assert.notEqual(before.object.full_name, after.object.full_name);
  assert.equal(before.stability, 'stable-subject-mutable-alias');
});

test('ref binding composes through stable repository identity and 404 never proves absence', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const refObservation = await observe(operation(paths.ref), {
    owner: 'acme', repo: 'widget', ref: 'heads/main',
  }, response(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_A } }));
  const fact = projectGitRefTarget(refObservation, repository)!;
  assert.equal(fact.subject.repository_id, 42);
  assert.equal(fact.object.sha, SHA_A);
  assert.equal(evaluateGitRefTarget(refObservation, repository, {
    repository_id: 42, ref: 'heads/main', target_sha: SHA_A,
  }).state, 'SATISFIED');
  assert.equal(evaluateGitRefTarget(refObservation, repository, {
    repository_id: 42, ref: 'heads/main', target_sha: SHA_B,
  }).state, 'UNSATISFIED');

  const missing = await observe(operation(paths.ref), {
    owner: 'acme', repo: 'widget', ref: 'heads/missing',
  }, response(404, { message: 'Not Found' }));
  assert.deepEqual(evaluateGitRefTarget(missing, repository, {
    repository_id: 42, ref: 'heads/missing', target_sha: SHA_A,
  }), { state: 'INDETERMINATE', reason: 'NOT_VISIBLE_IS_NOT_ABSENCE' });
});

test('immutable commit projection requires request SHA, response SHA, and stable repository identity to agree', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const commit = await observe(operation(paths.commit), {
    owner: 'acme', repo: 'widget', commit_sha: SHA_A,
  }, response(200, {
    sha: SHA_A,
    tree: { sha: SHA_B },
    parents: [{ sha: SHA_C }],
  }));
  const fact = projectGitCommit(commit, repository)!;
  assert.equal(fact.subject.repository_id, 42);
  assert.equal(fact.subject.sha, SHA_A);
  assert.equal(fact.tree_sha, SHA_B);
  assert.equal(fact.stability, 'content-addressed');

  const mismatched = await observe(operation(paths.commit), {
    owner: 'acme', repo: 'widget', commit_sha: SHA_A,
  }, response(200, { sha: SHA_B, tree: { sha: SHA_C }, parents: [] }));
  assert.equal(projectGitCommit(mismatched, repository), null);
});

test('pull request is a mutable snapshot rather than an internal state machine', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const pull = await observe(operation(paths.pull), {
    owner: 'acme', repo: 'widget', pull_number: 17,
  }, response(200, {
    id: 1700,
    number: 17,
    state: 'open',
    head: { sha: SHA_A },
    base: { ref: 'main', sha: SHA_B },
  }));
  const fact = projectPullRequestSnapshot(pull, repository)!;
  assert.equal(fact.stability, 'mutable-snapshot');
  assert.equal(evaluatePullRequestSnapshot(fact, {
    repository_id: 42, number: 17, state: 'open', head_sha: SHA_A, base_ref: 'main',
  }).state, 'SATISFIED');
  assert.equal(evaluatePullRequestSnapshot(fact, {
    repository_id: 42, number: 17, state: 'closed',
  }).state, 'UNSATISFIED');
});

test('paginated collection proves positive membership but not absence, even on a terminal page', async () => {
  const repository = projectRepositoryIdentity(await repositoryObservation())!;
  const first = await observe(operation(paths.checks), {
    owner: 'acme', repo: 'widget', ref: SHA_A, page: 1, per_page: 1,
  }, response(200, {
    total_count: 2,
    check_runs: [{ id: 10, name: 'build', head_sha: SHA_A, status: 'completed', conclusion: 'success' }],
  }, { ...RESPONSE, link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=2>; rel="last"' }));
  const firstPage = projectCheckRunsPage(first, repository)!;
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
    check_runs: [{ id: 11, name: 'lint', head_sha: SHA_A, status: 'completed', conclusion: 'success' }],
  }, { ...RESPONSE, link: '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=1>; rel="first"' }));
  const terminalPage = projectCheckRunsPage(terminal, repository)!;
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
  const page = projectCheckRunsPage(empty, repository)!;
  assert.equal(page.members.length, 0);
  assert.equal(page.total_count, 0);
  assert.equal(page.negative_evidence_authoritative, false);
  assert.deepEqual(evaluateCheckRunPage(page, {
    repository_id: 42,
    ref: SHA_A,
    id: 123,
  }).state, 'INDETERMINATE');
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
  const commitObservation = await observe(operation(paths.commit), {
    owner: 'acme', repo: 'widget', commit_sha: SHA_A,
  }, response(200, { sha: SHA_A, tree: { sha: SHA_B }, parents: [] }));
  const commit = projectGitCommit(commitObservation, repository)!;

  const oldRefObservation = await observe(operation(paths.ref), {
    owner: 'acme', repo: 'widget', ref: 'heads/main',
  }, response(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_A } }));
  const oldRef = projectGitRefTarget(oldRefObservation, repository)!;

  const freshRefObservation = await observe(operation(paths.ref), {
    owner: 'acme', repo: 'widget', ref: 'heads/main',
  }, response(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: SHA_B } }));
  const freshRef = projectGitRefTarget(freshRefObservation, repository)!;

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
