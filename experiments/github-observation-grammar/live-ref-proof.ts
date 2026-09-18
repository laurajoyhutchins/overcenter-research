import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  deriveObservationOperation,
  GitHubRestTransport,
  observeOperation,
  type OpenApiDocument,
} from './openapi.ts';
import { evaluateGitRefTarget, projectRepositoryIdentity } from './semantics.ts';

const schemaPath = process.argv[2];
if (!schemaPath) throw new Error('usage: live-ref-proof.ts <openapi.json>');
const repositoryName = process.env.GITHUB_REPOSITORY;
const branch = process.env.GITHUB_REF_NAME;
const expectedSha = process.env.GITHUB_SHA;
if (!repositoryName || !branch || !expectedSha) throw new Error('GITHUB_ACTIONS_IDENTITY_REQUIRED');
const [owner, repo] = repositoryName.split('/');
if (!owner || !repo) throw new Error('GITHUB_REPOSITORY_INVALID');

const bytes = readFileSync(schemaPath);
const document = JSON.parse(bytes.toString('utf8')) as OpenApiDocument;
const provenance = {
  schema_sha256: createHash('sha256').update(bytes).digest('hex'),
  observer: { kind: 'github-actions-run', id: `${repositoryName}:${process.env.GITHUB_RUN_ID ?? 'unknown'}` },
};
const transport = new GitHubRestTransport({ token: process.env.GITHUB_TOKEN ?? null });
const repoObservation = await observeOperation(
  deriveObservationOperation(document, {
    apiVersion: '2026-03-10',
    method: 'get',
    pathTemplate: '/repos/{owner}/{repo}',
  }),
  { owner, repo },
  transport,
  provenance,
);
const repository = projectRepositoryIdentity(repoObservation);
assert.ok(repository);

const operation = deriveObservationOperation(document, {
  apiVersion: '2026-03-10',
  method: 'get',
  pathTemplate: '/repos/{owner}/{repo}/git/ref/{ref}',
});
const ref = `heads/${branch}`;
const observation = await observeOperation(
  operation,
  { owner, repo, ref },
  transport,
  provenance,
);
const evaluation = evaluateGitRefTarget(observation, repository, {
  repository_id: repository.subject.id,
  ref,
  target_sha: expectedSha,
});

console.log(JSON.stringify({ observation, evaluation }, null, 2));
assert.equal(evaluation.state, 'SATISFIED');
