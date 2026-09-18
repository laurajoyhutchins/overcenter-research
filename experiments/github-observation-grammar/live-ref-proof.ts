import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deriveObservationOperation,
  GitHubRestTransport,
  observeOperation,
  type OpenApiDocument,
} from './openapi.ts';
import { evaluateGitRefTarget } from './semantics.ts';

const schemaPath = process.argv[2];
if (!schemaPath) throw new Error('usage: github-ref-live-proof.ts <openapi.json>');
const repository = process.env.GITHUB_REPOSITORY;
const branch = process.env.GITHUB_REF_NAME;
const expectedSha = process.env.GITHUB_SHA;
if (!repository || !branch || !expectedSha) throw new Error('GITHUB_ACTIONS_IDENTITY_REQUIRED');
const [owner, repo] = repository.split('/');
if (!owner || !repo) throw new Error('GITHUB_REPOSITORY_INVALID');

const document = JSON.parse(readFileSync(schemaPath, 'utf8')) as OpenApiDocument;
const operation = deriveObservationOperation(document, {
  apiVersion: '2026-03-10',
  method: 'get',
  pathTemplate: '/repos/{owner}/{repo}/git/ref/{ref}',
});
const ref = `heads/${branch}`;
const observation = await observeOperation(
  operation,
  { owner, repo, ref },
  new GitHubRestTransport({ token: process.env.GITHUB_TOKEN ?? null }),
);
const evaluation = evaluateGitRefTarget(observation, {
  owner,
  repo,
  ref,
  target_sha: expectedSha,
});

console.log(JSON.stringify({ observation, evaluation }, null, 2));
assert.equal(evaluation.state, 'SATISFIED');
