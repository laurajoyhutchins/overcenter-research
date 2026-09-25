import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compileHostileMutationEvidenceFromRepository,
  HOSTILE_MUTATION_EVIDENCE_OBLIGATION_ID,
} from '../src/evidence/hostile-mutation-obligation.ts';
import { obligationDefinition, obligationDefinitionId } from '../src/authority/facts.ts';
import type { GithubHostileMutationEvidencePostcondition } from '../src/model.ts';
import { observationVerified, observePostcondition } from '../src/observation/observe.ts';
import { observeGithubHostileMutationEvidence } from '../src/providers/github/hostile-mutation-evidence.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function commit(repo: string, message: string): string {
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', message], { stdio: 'ignore' });
  return git(repo, ['rev-parse', 'HEAD']);
}

function definitionId(repo: string, sourceSha: string): string {
  return obligationDefinitionId(
    obligationDefinition(
      compileHostileMutationEvidenceFromRepository({
        repo,
        sourceSha,
        repositoryId: 42,
        repositoryFullName: 'acme/widget',
      }),
    ),
  );
}

test('hostile evidence obligation changes only with protected semantics or evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-hostile-evidence-obligation-'));
  try {
    execFileSync('git', ['-C', root, 'init', '--initial-branch=main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Overcenter Test'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', root, 'config', 'user.email', 'overcenter-test@local'], {
      stdio: 'ignore',
    });

    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'experiments', 'production-criticality-ranking'), { recursive: true });
    writeFileSync(join(root, 'src', 'protected.ts'), 'export const protectedValue = 1;\n');
    writeFileSync(join(root, 'unrelated.txt'), 'one\n');
    writeFileSync(
      join(root, 'experiments', 'production-criticality-ranking', 'mutation-probes.json'),
      JSON.stringify({
        schema: 'overcenter-criticality-mutation-probes/v1',
        probes: [
          {
            id: 'protected-proof',
            selectors: [{ file: 'src/protected.ts', name: 'protectedValue' }],
            tests: ['test/protected.test.ts'],
          },
        ],
      }),
    );
    writeFileSync(
      join(root, 'experiments', 'production-criticality-ranking', 'mutation-evidence.json'),
      JSON.stringify({ schema: 'overcenter-criticality-mutation-evidence', probes: [] }),
    );

    const base = commit(root, 'seed');
    const first = definitionId(root, base);

    writeFileSync(join(root, 'unrelated.txt'), 'two\n');
    const unrelated = commit(root, 'unrelated change');
    assert.equal(definitionId(root, unrelated), first);

    writeFileSync(join(root, 'src', 'protected.ts'), 'export const protectedValue = 2;\n');
    const protectedChange = commit(root, 'protected change');
    const changedSource = definitionId(root, protectedChange);
    assert.notEqual(changedSource, first);

    writeFileSync(
      join(root, 'experiments', 'production-criticality-ranking', 'mutation-evidence.json'),
      JSON.stringify({
        schema: 'overcenter-criticality-mutation-evidence',
        probes: [{ id: 'new-evidence' }],
      }),
    );
    const evidenceChange = commit(root, 'evidence change');
    assert.notEqual(definitionId(root, evidenceChange), changedSource);

    const obligation = compileHostileMutationEvidenceFromRepository({
      repo: root,
      sourceSha: evidenceChange,
      repositoryId: 42,
      repositoryFullName: 'acme/widget',
    });
    assert.equal(obligation.id, HOSTILE_MUTATION_EVIDENCE_OBLIGATION_ID);
    assert.equal(obligation.packet.kind, 'system-evidence');
    assert.deepEqual(Object.keys(obligation.packet.source_blobs as object), ['src/protected.ts']);
    assert.equal(obligation.postcondition.verifier, 'github-hostile-mutation-evidence/v1');
    assert.deepEqual(Object.keys(obligation.postcondition).sort(), [
      'evidence_path',
      'expected_sha256',
      'provider',
      'ref',
      'repository_full_name',
      'repository_id',
      'source_blobs',
      'verifier',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('GitHub hostile evidence observation fails currentness on source drift', () => {
  const sourceBlob = 'c'.repeat(40);
  const revision = 'a'.repeat(40);
  const artifactDigest = `sha256:${'b'.repeat(64)}`;
  const evidence = Buffer.from(
    JSON.stringify({
      schema: 'overcenter-criticality-mutation-evidence',
      probes: [
        {
          id: 'protected-proof',
          source_run: {
            revision,
            workflow_run_id: 123,
            mutation_report_sha256: `sha256:${'d'.repeat(64)}`,
            artifact_digest: artifactDigest,
          },
          source_blobs: { 'src/core.ts': sourceBlob },
          selectors: [{ file: 'src/core.ts', qualifiedName: 'core' }],
          total: 1,
          killed: 1,
          survived: 0,
          no_coverage: 0,
          timeout_or_error: 0,
          mutation_score: 1,
        },
      ],
    }),
  );
  const postcondition: GithubHostileMutationEvidencePostcondition = {
    verifier: 'github-hostile-mutation-evidence/v1',
    provider: 'github',
    repository_id: 42,
    repository_full_name: 'acme/widget',
    ref: 'main',
    evidence_path: 'experiments/production-criticality-ranking/mutation-evidence.json',
    expected_sha256: sha256(evidence),
    source_blobs: { 'src/core.ts': sourceBlob },
  };

  const evidencePath =
    '/repos/acme/widget/contents/experiments/production-criticality-ranking/mutation-evidence.json?ref=main';
  const sourcePath = '/repos/acme/widget/contents/src/core.ts?ref=main';
  const responses = new Map<string, unknown>([
    ['/repos/acme/widget', { id: 42, full_name: 'acme/widget' }],
    [
      evidencePath,
      {
        type: 'file',
        sha: 'e'.repeat(40),
        encoding: 'base64',
        content: evidence.toString('base64'),
      },
    ],
    [
      sourcePath,
      {
        type: 'file',
        sha: sourceBlob,
        encoding: 'base64',
        content: Buffer.from('export const core = true;\n').toString('base64'),
      },
    ],
    [
      '/repos/acme/widget/actions/runs/123',
      {
        path: '.github/workflows/production-criticality-mutation-probe.yml',
        head_sha: revision,
        conclusion: 'success',
      },
    ],
    [
      '/repos/acme/widget/actions/runs/123/jobs?per_page=100',
      { jobs: [{ name: 'mutate', conclusion: 'success' }] },
    ],
    [
      '/repos/acme/widget/actions/runs/123/artifacts?per_page=100',
      {
        artifacts: [
          {
            name: 'production-criticality-mutation-probe',
            expired: false,
            digest: artifactDigest,
          },
        ],
      },
    ],
  ]);
  const get = (_token: string, path: string) => {
    if (!responses.has(path)) throw new Error(`unexpected GitHub read: ${path}`);
    return responses.get(path);
  };

  const context = {
    githubToken: 'token',
    githubGet: get,
    observeGithubHostileMutationEvidence: (candidate: GithubHostileMutationEvidencePostcondition) =>
      observeGithubHostileMutationEvidence('token', candidate, get),
  };

  const current = observePostcondition(postcondition, context);
  assert.equal(current.actual_state, 'current');
  assert.equal(observationVerified(postcondition, current), true);

  responses.set(sourcePath, {
    type: 'file',
    sha: 'f'.repeat(40),
    encoding: 'base64',
    content: Buffer.from('export const core = false;\n').toString('base64'),
  });
  const stale = observePostcondition(postcondition, context);
  assert.equal(stale.actual_state, 'stale');
  assert.equal(stale.mutation_certainty, 'present');
  assert.equal(observationVerified(postcondition, stale), false);

  responses.set(sourcePath, {
    type: 'file',
    sha: sourceBlob,
    encoding: 'base64',
    content: Buffer.from('export const core = true;\n').toString('base64'),
  });
  responses.set('/repos/acme/widget/actions/runs/123', {
    path: '.github/workflows/production-criticality-mutation-probe.yml',
    head_sha: revision,
    conclusion: 'failure',
  });
  const invalidAuthority = observePostcondition(postcondition, context);
  assert.equal(invalidAuthority.mutation_certainty, 'uncertain');
  assert.equal(observationVerified(postcondition, invalidAuthority), false);
});
