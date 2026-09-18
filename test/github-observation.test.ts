import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveObservationCatalog,
  deriveObservationOperation,
  observeOperation,
  type OpenApiDocument,
} from '../src/github-openapi.ts';
import { evaluateGitRefTarget, projectGitRefTarget } from '../src/github-semantics.ts';

const pathTemplate = '/repos/{owner}/{repo}/git/ref/{ref}';
const openapi: OpenApiDocument = {
  paths: {
    [pathTemplate]: {
      get: {
        operationId: 'git/get-ref',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ref', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Response', content: { 'application/json': { schema: { type: 'object' } } } },
          '404': { description: 'Resource not found' },
        },
        'x-github': { enabledForGitHubApps: true },
      },
      patch: {
        operationId: 'git/update-ref',
        responses: { '200': { description: 'Response' } },
      },
    },
  },
};

const desired = 'a'.repeat(40);
const other = 'b'.repeat(40);
const obligation = { owner: 'acme', repo: 'widget', ref: 'heads/main', target_sha: desired };

function operation() {
  return deriveObservationOperation(openapi, {
    apiVersion: '2026-03-10',
    method: 'get',
    pathTemplate,
  });
}

test('OpenAPI mechanically yields a read-only GitHub observation descriptor', () => {
  const descriptor = operation();
  assert.equal(descriptor.operation_id, 'git/get-ref');
  assert.equal(descriptor.method, 'GET');
  assert.deepEqual(descriptor.parameters.map(p => [p.in, p.name]), [
    ['path', 'owner'],
    ['path', 'ref'],
    ['path', 'repo'],
  ]);
  assert.deepEqual(descriptor.outcomes.map(o => o.status), ['200', '404']);
  assert.equal(descriptor.github_extensions.enabledForGitHubApps, true);

  const catalog = deriveObservationCatalog(openapi, '2026-03-10');
  assert.deepEqual(catalog.map(x => x.operation_id), ['git/get-ref']);
  assert.throws(() => deriveObservationOperation(openapi, {
    apiVersion: '2026-03-10', method: 'patch', pathTemplate,
  }), /OBSERVATION_OPERATION_MUST_BE_READ_ONLY/);
});

test('authoritative 200 readback becomes a binding fact and satisfies exact-SHA obligation', async () => {
  const observed = await observeOperation(operation(), {
    owner: 'acme', repo: 'widget', ref: 'heads/main',
  }, {
    request: async input => {
      assert.equal(input.apiVersion, '2026-03-10');
      assert.equal(input.path, '/repos/acme/widget/git/ref/heads%2Fmain');
      return {
        status: 200,
        body: { ref: 'refs/heads/main', object: { type: 'commit', sha: desired } },
      };
    },
  });

  const fact = projectGitRefTarget(observed);
  assert.equal(fact?.kind, 'binding');
  assert.equal(fact?.subject.ref, 'refs/heads/main');
  assert.equal(fact?.object.sha, desired);
  assert.deepEqual(evaluateGitRefTarget(observed, obligation), {
    state: 'SATISFIED',
    reason: 'AUTHORITATIVE_BINDING_MATCHES',
    fact,
  });
});

test('a positive mismatching binding proves the obligation unsatisfied', async () => {
  const observed = await observeOperation(operation(), {
    owner: 'acme', repo: 'widget', ref: 'heads/main',
  }, {
    request: async () => ({
      status: 200,
      body: { ref: 'refs/heads/main', object: { type: 'commit', sha: other } },
    }),
  });
  assert.equal(evaluateGitRefTarget(observed, obligation).state, 'UNSATISFIED');
});

test('404 is not silently strengthened into proof of absence', async () => {
  const observed = await observeOperation(operation(), {
    owner: 'acme', repo: 'widget', ref: 'heads/main',
  }, {
    request: async () => ({ status: 404, body: { message: 'Not Found' } }),
  });

  assert.equal(observed.outcome.visibility, 'not-observed');
  assert.equal(projectGitRefTarget(observed), null);
  assert.deepEqual(evaluateGitRefTarget(observed, obligation), {
    state: 'INDETERMINATE',
    reason: 'NOT_VISIBLE_IS_NOT_ABSENCE',
  });
});

test('transport failure remains indeterminate rather than becoming negative evidence', async () => {
  const observed = await observeOperation(operation(), {
    owner: 'acme', repo: 'widget', ref: 'heads/main',
  }, {
    request: async () => { throw new Error('network'); },
  });
  assert.deepEqual(evaluateGitRefTarget(observed, obligation), {
    state: 'INDETERMINATE',
    reason: 'OBSERVATION_INDETERMINATE',
  });
});


test('GitHub REST transport pins API version and returns raw provider response', async () => {
  const calls: Array<{ url: string; init: { method: 'GET' | 'HEAD'; headers: Record<string, string> } }> = [];
  const transport = new GitHubRestTransport({
    token: 'test-token',
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return {
        status: 200,
        text: async () => JSON.stringify({ ref: 'refs/heads/main', object: { type: 'commit', sha: desired } }),
      };
    },
  });
  const response = await transport.request({
    method: 'GET',
    path: '/repos/acme/widget/git/ref/heads%2Fmain',
    apiVersion: '2026-03-10',
  });
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/widget/git/ref/heads%2Fmain');
  assert.equal(calls[0].init.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(response.status, 200);
  assert.equal((response.body as { ref: string }).ref, 'refs/heads/main');
});
