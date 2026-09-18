import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  deriveObservationOperation,
  GitHubRestTransport,
  observeOperation,
  type ObservationOperation,
  type ObservationProvenance,
  type OpenApiDocument,
  type RawObservation,
} from './openapi.ts';
import {
  validateObservationStructure,
  validateSelectedObservationStructure,
  type StructuralSelection,
} from './structural-decoder.ts';

const schemaPath = process.argv[2];
if (!schemaPath) throw new Error('usage: live-structural-proof.ts <openapi.json>');

const repositoryName = required('GITHUB_REPOSITORY');
const sourceRef = required('SOURCE_REF');
const sourceSha = required('SOURCE_SHA');
const checkRef = required('CHECK_REF');
const statusRef = required('STATUS_REF');
const pullNumber = process.env.PULL_NUMBER ? Number(process.env.PULL_NUMBER) : null;
if (pullNumber !== null && (!Number.isSafeInteger(pullNumber) || pullNumber <= 0)) {
  throw new Error('PULL_NUMBER_INVALID');
}
const [owner, repo] = repositoryName.split('/');
if (!owner || !repo) throw new Error('GITHUB_REPOSITORY_INVALID');

const schemaBytes = readFileSync(schemaPath);
const document = JSON.parse(schemaBytes.toString('utf8')) as OpenApiDocument;
const provenance: ObservationProvenance = {
  schema_sha256: createHash('sha256').update(schemaBytes).digest('hex'),
  observer: {
    kind: 'github-actions-run',
    id: `${repositoryName}:${required('GITHUB_RUN_ID')}:${required('GITHUB_RUN_ATTEMPT')}`,
  },
};
const transport = new GitHubRestTransport({ token: process.env.GITHUB_TOKEN ?? null });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function op(pathTemplate: string): ObservationOperation {
  return deriveObservationOperation(document, {
    apiVersion: '2026-03-10',
    method: 'get',
    pathTemplate,
  });
}

async function observed(
  operation: ObservationOperation,
  values: Record<string, string | number | boolean>,
): Promise<RawObservation> {
  const observation = await observeOperation(operation, values, transport, provenance);
  assert.equal(
    observation.outcome.status,
    200,
    `${operation.operation_id} live observation must return 200 before structural validation`,
  );
  return observation;
}

interface LiveStructuralResult {
  operation_id: string;
  response_status: number;
  selected_state: 'VALID';
  full_state: 'VALID' | 'INVALID' | 'UNSUPPORTED';
  full_problems: Array<{ path: string; reason: string }>;
}

function assertSelectedValid(
  operation: ObservationOperation,
  observation: RawObservation,
  selection: StructuralSelection,
  { requireFull = true }: { requireFull?: boolean } = {},
): LiveStructuralResult {
  const full = validateObservationStructure(operation, observation);
  const selected = validateSelectedObservationStructure(operation, observation, selection);
  assert.equal(
    selected.state,
    'VALID',
    `${operation.operation_id} selected structural result: ${JSON.stringify(selected)}`,
  );
  if (requireFull) {
    assert.equal(
      full.state,
      'VALID',
      `${operation.operation_id} full structural result: ${JSON.stringify(full)}`,
    );
  }
  return {
    operation_id: operation.operation_id,
    response_status: observation.outcome.status,
    selected_state: 'VALID',
    full_state: full.state,
    full_problems: full.problems,
  };
}

const results: LiveStructuralResult[] = [];

const repoOperation = op('/repos/{owner}/{repo}');
results.push(assertSelectedValid(
  repoOperation,
  await observed(repoOperation, { owner, repo }),
  {
    properties: {
      id: true,
      node_id: true,
      full_name: true,
      name: true,
      owner: { properties: { login: true } },
    },
  },
));

const refOperation = op('/repos/{owner}/{repo}/git/ref/{ref}');
results.push(assertSelectedValid(
  refOperation,
  await observed(refOperation, { owner, repo, ref: `heads/${sourceRef}` }),
  {
    properties: {
      ref: true,
      object: { properties: { type: true, sha: true } },
    },
  },
));

const commitOperation = op('/repos/{owner}/{repo}/git/commits/{commit_sha}');
results.push(assertSelectedValid(
  commitOperation,
  await observed(commitOperation, { owner, repo, commit_sha: sourceSha }),
  {
    properties: {
      sha: true,
      tree: { properties: { sha: true } },
      parents: { items: { properties: { sha: true } } },
    },
  },
));

const checkOperation = op('/repos/{owner}/{repo}/commits/{ref}/check-runs');
results.push(assertSelectedValid(
  checkOperation,
  await observed(checkOperation, { owner, repo, ref: checkRef, page: 1, per_page: 1 }),
  {
    properties: {
      total_count: true,
      check_runs: {
        items: {
          properties: {
            id: true,
            name: true,
            head_sha: true,
            status: true,
            conclusion: true,
          },
        },
      },
    },
  },
));

const statusOperation = op('/repos/{owner}/{repo}/commits/{ref}/statuses');
results.push(assertSelectedValid(
  statusOperation,
  await observed(statusOperation, { owner, repo, ref: statusRef, page: 1, per_page: 1 }),
  {
    items: {
      properties: {
        id: true,
        node_id: true,
        state: true,
        context: true,
        target_url: true,
        created_at: true,
        updated_at: true,
      },
    },
  },
));

const runsOperation = op('/repos/{owner}/{repo}/actions/runs');
results.push(assertSelectedValid(
  runsOperation,
  await observed(runsOperation, { owner, repo, page: 1, per_page: 1 }),
  {
    properties: {
      total_count: true,
      workflow_runs: {
        items: {
          properties: {
            id: true,
            node_id: true,
            workflow_id: true,
            run_number: true,
            run_attempt: true,
            name: true,
            event: true,
            status: true,
            conclusion: true,
            head_sha: true,
          },
        },
      },
    },
  },
));

if (pullNumber !== null) {
  const pullOperation = op('/repos/{owner}/{repo}/pulls/{pull_number}');
  results.push(assertSelectedValid(
    pullOperation,
    await observed(pullOperation, { owner, repo, pull_number: pullNumber }),
    {
      properties: {
        id: true,
        node_id: true,
        number: true,
        state: true,
        head: { properties: { sha: true } },
        base: { properties: { ref: true, sha: true } },
      },
    },
  ));

  const issueOperation = op('/repos/{owner}/{repo}/issues/{issue_number}');
  results.push(assertSelectedValid(
    issueOperation,
    await observed(issueOperation, { owner, repo, issue_number: pullNumber }),
    {
      properties: {
        id: true,
        node_id: true,
        number: true,
        state: true,
        title: true,
        locked: true,
        pull_request: true,
      },
    },
    { requireFull: false },
  ));
}

console.log(JSON.stringify({
  schema_sha256: provenance.schema_sha256,
  observer: provenance.observer,
  structural_validation: results,
}, null, 2));
