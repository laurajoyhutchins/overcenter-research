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
  type GithubFact,
} from './semantics.ts';
import { reconstructGithubProjection } from './reconstruction.ts';

const schemaPath = process.argv[2];
if (!schemaPath) throw new Error('usage: live-semantic-proof.ts <openapi.json>');
const repositoryName = required('GITHUB_REPOSITORY');
const sourceRef = required('SOURCE_REF');
const sourceSha = required('SOURCE_SHA');
const checkRef = required('CHECK_REF');
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

const repoOperation = op('/repos/{owner}/{repo}');
const repoObservation = await observeOperation(repoOperation, { owner, repo }, transport, provenance);
assert.equal(repoObservation.outcome.status, 200);
assert.equal(repoObservation.request.authorization, 'bearer');
assert.equal(repoObservation.contract.schema_sha256, schemaSha);
const repository = projectRepositoryIdentity(repoObservation);
assert.ok(repository);

// Conditional HTTP is a cross-cutting transport semantic, not a GitHub resource model.
assert.ok(repoObservation.response.etag, 'repository response must expose ETag for conditional proof');
const notModified = await observeOperation(
  repoOperation,
  { owner, repo },
  transport,
  provenance,
  { headers: { 'If-None-Match': repoObservation.response.etag } },
);
assert.equal(notModified.outcome.status, 304);
const revalidatedRepositoryObservation = revalidateNotModified(repoObservation, notModified);
assert.ok(revalidatedRepositoryObservation);
const revalidatedRepository = projectRepositoryIdentity(revalidatedRepositoryObservation);
assert.equal(revalidatedRepository?.subject.id, repository.subject.id);

const refName = `heads/${sourceRef}`;
const refObservation = await observeOperation(
  op('/repos/{owner}/{repo}/git/ref/{ref}'),
  { owner, repo, ref: refName },
  transport,
  provenance,
);
const refFact = projectGitRefTarget(refObservation, repository);
assert.ok(refFact);
assert.equal(evaluateGitRefTarget(refObservation, repository, {
  repository_id: repository.subject.id,
  ref: refName,
  target_sha: sourceSha,
}).state, 'SATISFIED');

const commitObservation = await observeOperation(
  op('/repos/{owner}/{repo}/git/commits/{commit_sha}'),
  { owner, repo, commit_sha: sourceSha },
  transport,
  provenance,
);
const commitFact = projectGitCommit(commitObservation, repository);
assert.ok(commitFact);
assert.equal(commitFact.subject.sha.toLowerCase(), sourceSha.toLowerCase());
assert.equal(commitFact.stability, 'content-addressed');

const currentFacts: GithubFact[] = [repository, refFact];
let pullFact = null;
if (pullNumber !== null) {
  const pullObservation = await observeOperation(
    op('/repos/{owner}/{repo}/pulls/{pull_number}'),
    { owner, repo, pull_number: pullNumber },
    transport,
    provenance,
  );
  pullFact = projectPullRequestSnapshot(pullObservation, repository);
  assert.ok(pullFact);
  assert.equal(evaluatePullRequestSnapshot(pullFact, {
    repository_id: repository.subject.id,
    number: pullNumber,
    state: 'open',
    head_sha: sourceSha,
    base_ref: 'main',
  }).state, 'SATISFIED');
  currentFacts.push(pullFact);
}

const checksOperation = op('/repos/{owner}/{repo}/commits/{ref}/check-runs');
const checksObservation = await observeOperation(
  checksOperation,
  { owner, repo, ref: checkRef, page: 1, per_page: 1 },
  transport,
  provenance,
);
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

let volatileChecks: { ref: string; members: number; missing_member: string } | null = null;
if (volatileCheckRef) {
  const volatileObservation = await observeOperation(
    checksOperation,
    { owner, repo, ref: volatileCheckRef, page: 1, per_page: 1 },
    transport,
    provenance,
  );
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
if (pullNumber !== null) assert.ok(rebuilt.pull_requests[`${repository.subject.id}:${pullNumber}`]);

console.log(JSON.stringify({
  schema_sha256: schemaSha,
  observer: provenance.observer,
  repository: {
    id: repository.subject.id,
    full_name: repository.object.full_name,
    etag: repoObservation.response.etag,
    revalidated_at: revalidatedRepositoryObservation.observed_at,
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
    state: pullFact.state,
    head_sha: pullFact.head_sha,
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
  reconstruction: {
    durable_commits: Object.keys(rebuilt.commits).length,
    current_refs: Object.keys(rebuilt.refs).length,
    current_pull_requests: Object.keys(rebuilt.pull_requests).length,
  },
}, null, 2));
