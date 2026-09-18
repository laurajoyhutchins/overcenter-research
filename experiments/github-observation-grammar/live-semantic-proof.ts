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
  type GithubFact,
} from './semantics.ts';
import { reconstructGithubProjection } from './reconstruction.ts';
import {
  RESPONSE_SLICES,
  validateObservationSlice,
  validateResponseSlice,
  type ResponseSliceResult,
  type StructurallyValidatedObservation,
} from './response-slice.ts';

const schemaPath = process.argv[2];
if (!schemaPath) throw new Error('usage: live-semantic-proof.ts <openapi.json>');
const repositoryName = required('GITHUB_REPOSITORY');
const sourceRef = required('SOURCE_REF');
const sourceSha = required('SOURCE_SHA');
const checkRef = required('CHECK_REF');
const statusRef = required('STATUS_REF');
const baseRef = required('BASE_REF');
const volatileCheckRef = process.env.VOLATILE_CHECK_REF ?? null;
const [owner, repo] = repositoryName.split('/');
if (!owner || !repo) throw new Error('GITHUB_REPOSITORY_INVALID');
const pullNumber = process.env.PULL_NUMBER ? Number(process.env.PULL_NUMBER) : null;
if (pullNumber !== null && (!Number.isSafeInteger(pullNumber) || pullNumber <= 0)) throw new Error('PULL_NUMBER_INVALID');

const schemaBytes = readFileSync(schemaPath);
const document = JSON.parse(schemaBytes.toString('utf8')) as OpenApiDocument;
const schemaSha = createHash('sha256').update(schemaBytes).digest('hex');
const transport = new GitHubRestTransport({ token: process.env.GITHUB_TOKEN ?? null });
const provenance: ObservationProvenance = {
  schema_sha256: schemaSha,
  observer: {
    kind: 'github-actions-run',
    id: `${repositoryName}:${required('GITHUB_RUN_ID')}:${required('GITHUB_RUN_ATTEMPT')}`,
  },
};

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

const structuralSlices: ResponseSliceResult[] = [];

function validateSlice(
  operation: ObservationOperation,
  observation: RawObservation,
): StructurallyValidatedObservation {
  assert.equal(observation.outcome.status, 200);
  const fields = RESPONSE_SLICES[
    operation.operation_id as keyof typeof RESPONSE_SLICES
  ];
  assert.ok(fields, `response slice missing for ${operation.operation_id}`);
  const validated = validateObservationSlice(operation, observation, fields);
  structuralSlices.push(validated.structural_validation);
  return validated;
}

const repoOperation = op('/repos/{owner}/{repo}');
const repoObservation = await observeOperation(repoOperation, { owner, repo }, transport, provenance);
assert.equal(repoObservation.outcome.status, 200);
assert.equal(repoObservation.request.authorization, 'bearer');
assert.equal(repoObservation.contract.schema_sha256, schemaSha);
const validatedRepoObservation = validateSlice(repoOperation, repoObservation);
const repository = projectRepositoryIdentity(validatedRepoObservation);
assert.ok(repository);

// Conditional HTTP is a cross-cutting transport semantic, not a GitHub resource model.
assert.ok(repoObservation.response.etag, 'repository response must expose ETag for conditional proof');
const conditionalObservation = await observeOperation(
  repoOperation,
  { owner, repo },
  transport,
  provenance,
  { headers: { 'If-None-Match': repoObservation.response.etag } },
);
let refreshedRepositoryObservation: StructurallyValidatedObservation;
let conditionalResult: 'NOT_MODIFIED' | 'MODIFIED';
if (conditionalObservation.outcome.status === 304) {
  const revalidated = revalidateNotModified(validatedRepoObservation, conditionalObservation);
  assert.ok(revalidated);
  refreshedRepositoryObservation = validateSlice(repoOperation, revalidated);
  conditionalResult = 'NOT_MODIFIED';
} else {
  // The repository representation may legitimately change between reads.
  // In that case GitHub returns a fresh 200 representation instead of 304.
  assert.equal(conditionalObservation.outcome.status, 200);
  refreshedRepositoryObservation = validateSlice(repoOperation, conditionalObservation);
  conditionalResult = 'MODIFIED';
}
const refreshedRepository = projectRepositoryIdentity(refreshedRepositoryObservation);
assert.equal(refreshedRepository?.subject.id, repository.subject.id);

const refName = `heads/${sourceRef}`;
const refOperation = op('/repos/{owner}/{repo}/git/ref/{ref}');
const refObservation = await observeOperation(
  refOperation,
  { owner, repo, ref: refName },
  transport,
  provenance,
);
const validatedRefObservation = validateSlice(refOperation, refObservation);
const refFact = projectGitRefTarget(validatedRefObservation, repository);
assert.ok(refFact);
assert.equal(evaluateGitRefTarget(validatedRefObservation, repository, {
  repository_id: repository.subject.id,
  ref: refName,
  target_sha: sourceSha,
}).state, 'SATISFIED');

const commitOperation = op('/repos/{owner}/{repo}/git/commits/{commit_sha}');
const commitObservation = await observeOperation(
  commitOperation,
  { owner, repo, commit_sha: sourceSha },
  transport,
  provenance,
);
validateSlice(commitOperation, commitObservation);
const commitFact = projectGitCommit(commitObservation, repository);
assert.ok(commitFact);
assert.equal(commitFact.subject.sha.toLowerCase(), sourceSha.toLowerCase());
assert.equal(commitFact.stability, 'content-addressed');

const currentFacts: GithubFact[] = [repository, refFact];
let pullFact = null;
let issueFact = null;
if (pullNumber !== null) {
  const pullOperation = op('/repos/{owner}/{repo}/pulls/{pull_number}');
  const pullObservation = await observeOperation(
    pullOperation,
    { owner, repo, pull_number: pullNumber },
    transport,
    provenance,
  );
  validateSlice(pullOperation, pullObservation);
  pullFact = projectPullRequestSnapshot(pullObservation, repository);
  assert.ok(pullFact);
  assert.equal(evaluatePullRequestSnapshot(pullFact, {
    repository_id: repository.subject.id,
    number: pullNumber,
    state: 'open',
    head_sha: sourceSha,
    base_ref: baseRef,
  }).state, 'SATISFIED');

  const issueOperation = op('/repos/{owner}/{repo}/issues/{issue_number}');
  const issueObservation = await observeOperation(
    issueOperation,
    { owner, repo, issue_number: pullNumber },
    transport,
    provenance,
  );
  validateSlice(issueOperation, issueObservation);
  issueFact = projectIssueSnapshot(issueObservation, repository);
  assert.ok(issueFact);
  assert.equal(issueFact.is_pull_request, true);
  assert.notEqual(issueFact.subject.id, pullFact.subject.id);
  assert.equal(issueFact.subject.node_id, pullFact.subject.node_id);
  assert.equal(sameGithubEntity(issueFact, pullFact), true);
  assert.equal(evaluateIssueSnapshot(issueFact, {
    repository_id: repository.subject.id,
    number: pullNumber,
    state: 'open',
  }).state, 'SATISFIED');

  currentFacts.push(pullFact, issueFact);
}

const checksOperation = op('/repos/{owner}/{repo}/commits/{ref}/check-runs');
const checksObservation = await observeOperation(
  checksOperation,
  { owner, repo, ref: checkRef, page: 1, per_page: 1 },
  transport,
  provenance,
);
validateSlice(checksOperation, checksObservation);
const checksPage = projectCheckRunsPage(checksObservation, repository);
assert.ok(checksPage);
assert.ok(checksPage.members.length > 0, 'stable check coordinate should expose at least one check run');
const firstCheck = checksPage.members[0];
assert.equal(evaluateCheckRunPage(checksPage, {
  repository_id: repository.subject.id,
  ref: checkRef,
  id: firstCheck.id,
  head_sha: firstCheck.head_sha,
}).state, 'SATISFIED');
assert.equal(evaluateCheckRunPage(checksPage, {
  repository_id: repository.subject.id,
  ref: checkRef,
  id: Number.MAX_SAFE_INTEGER,
}).reason, 'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');
currentFacts.push(checksPage);

const statusOperation = op('/repos/{owner}/{repo}/commits/{ref}/statuses');
const statusObservation = await observeOperation(
  statusOperation,
  { owner, repo, ref: statusRef, page: 1, per_page: 1 },
  transport,
  provenance,
);
validateSlice(statusOperation, statusObservation);
const statusPage = projectCommitStatusesPage(statusObservation, repository);
assert.ok(statusPage);
assert.ok(statusPage.members.length > 0, 'stable status coordinate should expose at least one commit status');
const firstStatus = statusPage.members[0];
assert.equal(evaluateCommitStatusPage(statusPage, {
  repository_id: repository.subject.id,
  ref: statusRef,
  node_id: firstStatus.node_id,
  context: firstStatus.context,
  state: firstStatus.state,
}).state, 'SATISFIED');
assert.equal(evaluateCommitStatusPage(statusPage, {
  repository_id: repository.subject.id,
  ref: statusRef,
  node_id: 'missing-status-node',
}).reason, 'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');
currentFacts.push(statusPage);

let volatileChecks: { ref: string; members: number; missing_member: string } | null = null;
if (volatileCheckRef) {
  const volatileObservation = await observeOperation(
    checksOperation,
    { owner, repo, ref: volatileCheckRef, page: 1, per_page: 1 },
    transport,
    provenance,
  );
  validateSlice(checksOperation, volatileObservation);
  const volatilePage = projectCheckRunsPage(volatileObservation, repository);
  assert.ok(volatilePage);
  const missing = evaluateCheckRunPage(volatilePage, {
    repository_id: repository.subject.id,
    ref: volatileCheckRef,
    id: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(missing.state, 'INDETERMINATE');
  assert.equal(missing.reason, 'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');
  volatileChecks = {
    ref: volatileCheckRef,
    members: volatilePage.members.length,
    missing_member: missing.state,
  };
}

const workflowOperation = op('/repos/{owner}/{repo}/actions/runs');
const workflowObservation = await observeOperation(
  workflowOperation,
  { owner, repo, page: 1, per_page: 1 },
  transport,
  provenance,
);
validateSlice(workflowOperation, workflowObservation);
const workflowPage = projectWorkflowRunsPage(workflowObservation, repository);
assert.ok(workflowPage);
assert.ok(workflowPage.members.length > 0, 'repository should expose at least one workflow run');
const firstWorkflowRun = workflowPage.members[0];
assert.equal(evaluateWorkflowRunPage(workflowPage, {
  repository_id: repository.subject.id,
  node_id: firstWorkflowRun.node_id,
  workflow_id: firstWorkflowRun.workflow_id,
  head_sha: firstWorkflowRun.head_sha,
  event: firstWorkflowRun.event,
  status: firstWorkflowRun.status,
  conclusion: firstWorkflowRun.conclusion,
}).state, 'SATISFIED');
assert.equal(evaluateWorkflowRunPage(workflowPage, {
  repository_id: repository.subject.id,
  node_id: 'missing-workflow-run-node',
}).reason, 'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');
currentFacts.push(workflowPage);

// Reconstruction deliberately refuses to resurrect mutable state from durable history.
const durableFacts: GithubFact[] = [repository, commitFact, refFact];
const projectionWithoutFreshMutable = reconstructGithubProjection({
  durable: JSON.parse(JSON.stringify(durableFacts)),
  current: [],
});
assert.equal(Object.keys(projectionWithoutFreshMutable.commits).length, 1);
assert.equal(Object.keys(projectionWithoutFreshMutable.refs).length, 0);

const rebuilt = reconstructGithubProjection({
  durable: JSON.parse(JSON.stringify(durableFacts)),
  current: JSON.parse(JSON.stringify(currentFacts)),
});
assert.equal(rebuilt.refs[`${repository.subject.id}:refs/heads/${sourceRef}`].object.sha.toLowerCase(), sourceSha.toLowerCase());
if (pullNumber !== null) {
  const surfaceKey = `${repository.subject.id}:${pullNumber}`;
  assert.equal(rebuilt.pull_requests[surfaceKey]?.subject.kind, 'github.pull-request');
  assert.equal(rebuilt.issues[surfaceKey]?.subject.kind, 'github.issue');
  assert.ok(pullFact && issueFact);
  const entityKey = `${repository.subject.id}:${pullFact.subject.node_id}`;
  assert.equal(rebuilt.entities[entityKey]?.pull_request?.subject.id, pullFact.subject.id);
  assert.equal(rebuilt.entities[entityKey]?.issue?.subject.id, issueFact.subject.id);
}

console.log(JSON.stringify({
  schema_sha256: schemaSha,
  observer: provenance.observer,
  repository: {
    id: repository.subject.id,
    full_name: repository.object.full_name,
    etag: repoObservation.response.etag,
    conditional_result: conditionalResult,
    refreshed_at: refreshedRepositoryObservation.observed_at,
  },
  commit: {
    sha: commitFact.subject.sha,
    tree_sha: commitFact.tree_sha,
    stability: commitFact.stability,
  },
  ref: {
    ref: refFact.subject.ref,
    target: refFact.object.sha,
    stability: refFact.stability,
  },
  pull_request: pullFact && {
    number: pullFact.subject.number,
    id: pullFact.subject.id,
    node_id: pullFact.subject.node_id,
    state: pullFact.state,
    head_sha: pullFact.head_sha,
  },
  issue_surface: issueFact && {
    number: issueFact.subject.number,
    id: issueFact.subject.id,
    node_id: issueFact.subject.node_id,
    is_pull_request: issueFact.is_pull_request,
    same_entity_as_pull: pullFact ? sameGithubEntity(issueFact, pullFact) : false,
  },
  checks: {
    stable_ref: checkRef,
    page_members: checksPage.members.length,
    total_count: checksPage.total_count,
    has_next: checksPage.has_next,
    positive_membership: 'SATISFIED',
    missing_member: 'INDETERMINATE',
    volatile_probe: volatileChecks,
  },
  commit_statuses: {
    stable_ref: statusRef,
    page_members: statusPage.members.length,
    has_next: statusPage.has_next,
    positive_membership: 'SATISFIED',
    missing_member: 'INDETERMINATE',
    first_context: firstStatus.context,
  },
  workflow_runs: {
    page_members: workflowPage.members.length,
    total_count: workflowPage.total_count,
    has_next: workflowPage.has_next,
    positive_membership: 'SATISFIED',
    missing_member: 'INDETERMINATE',
    first_run_id: firstWorkflowRun.id,
    first_workflow_id: firstWorkflowRun.workflow_id,
  },
  structural_response_slices: {
    observations_validated: structuralSlices.length,
    operations: [...new Set(structuralSlices.map(slice => slice.operation_id))],
    validated_paths: structuralSlices.reduce((sum, slice) => sum + slice.validated_paths.length, 0),
    optional_absent_paths: structuralSlices.reduce((sum, slice) => sum + slice.optional_absent_paths.length, 0),
  },
  reconstruction: {
    durable_commits: Object.keys(rebuilt.commits).length,
    current_refs: Object.keys(rebuilt.refs).length,
    current_pull_requests: Object.keys(rebuilt.pull_requests).length,
    current_issues: Object.keys(rebuilt.issues).length,
    unified_entities: Object.keys(rebuilt.entities).length,
  },
}, null, 2));
