import type { Observation } from '../../model.ts';
import { canonicalDigest, sha256 } from '../../digest.ts';
import {
  readGithubEvidenceFile,
  verifyGithubRepositoryIdentity,
  verifyGithubWorkflowArtifact,
} from './evidence-primitives.ts';
import { githubGet, type GithubJsonGet } from './rest.ts';

export interface GithubSourceBoundEvidenceCoordinates {
  verifier: Observation['verifier'];
  provider: 'github';
  repository_id: number;
  repository_full_name: string;
  ref: string;
  evidence_path: string;
  expected_sha256: string;
  source_blobs: Record<string, string>;
}

export interface GithubSourceBoundEvidenceRun {
  workflow_run_id: number;
  revision: string;
  artifact_digest: string;
}

export interface GithubSourceBoundEvidenceBinding {
  source_blobs: Record<string, string>;
  source_runs: GithubSourceBoundEvidenceRun[];
}

export interface GithubSourceBoundEvidenceAdapter {
  workflow_path: string;
  job_name: string;
  artifact_name: string;
  bindingFromEvidence(bytes: Buffer): GithubSourceBoundEvidenceBinding;
}

export function observeGithubSourceBoundEvidence(
  token: string,
  p: GithubSourceBoundEvidenceCoordinates,
  adapter: GithubSourceBoundEvidenceAdapter,
  get: GithubJsonGet = githubGet,
): Observation {
  const base = {
    verifier: p.verifier,
    provider: 'github' as const,
    repository_id: p.repository_id,
    repository_full_name: p.repository_full_name,
    ref: p.ref,
    evidence_path: p.evidence_path,
    expected_sha256: p.expected_sha256,
    source_binding_sha256: canonicalDigest(p.source_blobs),
  };

  try {
    verifyGithubRepositoryIdentity(token, {
      repositoryId: p.repository_id,
      repositoryFullName: p.repository_full_name,
      get,
    });

    const evidenceFile = readGithubEvidenceFile(token, {
      repositoryFullName: p.repository_full_name,
      path: p.evidence_path,
      ref: p.ref,
      get,
    });
    const actualSha256 = sha256(evidenceFile.bytes);
    const binding = adapter.bindingFromEvidence(evidenceFile.bytes);

    const expectedPaths = Object.keys(p.source_blobs).sort();
    const declaredPaths = Object.keys(binding.source_blobs).sort();
    const sourceEvidence: Record<string, unknown> = {};
    let current =
      actualSha256 === p.expected_sha256 &&
      JSON.stringify(expectedPaths) === JSON.stringify(declaredPaths);

    for (const path of expectedPaths) {
      const expected = p.source_blobs[path]!.toLowerCase();
      const declared = binding.source_blobs[path]?.toLowerCase();
      const observed = readGithubEvidenceFile(token, {
        repositoryFullName: p.repository_full_name,
        path,
        ref: p.ref,
        get,
      }).blob;
      sourceEvidence[path] = {
        expected_blob: expected,
        committed_evidence_blob: declared ?? null,
        observed_blob: observed,
      };
      if (declared !== expected || observed !== expected) current = false;
    }

    if (binding.source_runs.length === 0) {
      throw new Error('GITHUB_SOURCE_BOUND_EVIDENCE_RUNS_MISSING');
    }
    const sourceRuns = binding.source_runs.map((source) =>
      verifyGithubWorkflowArtifact(token, {
        repositoryFullName: p.repository_full_name,
        workflowRunId: source.workflow_run_id,
        revision: source.revision,
        workflowPath: adapter.workflow_path,
        jobName: adapter.job_name,
        artifactName: adapter.artifact_name,
        artifactDigest: source.artifact_digest,
        get,
      }),
    );

    return {
      ...base,
      actual_sha256: actualSha256,
      actual_state: current ? 'current' : 'stale',
      mutation_certainty: 'present',
      provider_evidence: {
        evidence_blob: evidenceFile.blob,
        source_blobs: sourceEvidence,
        source_runs: sourceRuns,
      },
    };
  } catch (error: unknown) {
    return {
      ...base,
      mutation_certainty: 'uncertain',
      observation_error: error instanceof Error ? error.message : String(error),
    };
  }
}
