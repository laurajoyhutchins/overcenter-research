import type {
  GithubSourceBoundEvidencePostcondition,
  Observation,
} from '../../model.ts';
import { canonicalDigest, sha256 } from '../../digest.ts';
import {
  readGithubEvidenceFile,
  verifyGithubRepositoryIdentity,
  verifyGithubWorkflowArtifact,
} from './evidence-primitives.ts';
import { githubGet, type GithubJsonGet } from './rest.ts';

export function githubSourceBoundEvidenceBindingDigest(
  p: GithubSourceBoundEvidencePostcondition,
): string {
  return canonicalDigest({
    source_blobs: p.source_blobs,
    evidence_source_blobs: p.evidence_source_blobs,
    source_runs: p.source_runs,
    workflow_path: p.workflow_path,
    job_name: p.job_name,
    artifact_name: p.artifact_name,
  });
}

export function observeGithubSourceBoundEvidence(
  token: string,
  p: GithubSourceBoundEvidencePostcondition,
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
    source_binding_sha256: githubSourceBoundEvidenceBindingDigest(p),
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

    const expectedPaths = Object.keys(p.source_blobs).sort();
    const evidencePaths = Object.keys(p.evidence_source_blobs).sort();
    const sourceEvidence: Record<string, unknown> = {};
    let current =
      actualSha256 === p.expected_sha256 &&
      JSON.stringify(expectedPaths) === JSON.stringify(evidencePaths);

    for (const path of expectedPaths) {
      const expected = p.source_blobs[path]!.toLowerCase();
      const declared = p.evidence_source_blobs[path]?.toLowerCase();
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

    if (p.source_runs.length === 0) {
      throw new Error('GITHUB_SOURCE_BOUND_EVIDENCE_RUNS_MISSING');
    }
    const sourceRuns = p.source_runs.map((source) =>
      verifyGithubWorkflowArtifact(token, {
        repositoryFullName: p.repository_full_name,
        workflowRunId: source.workflow_run_id,
        revision: source.revision,
        workflowPath: p.workflow_path,
        jobName: p.job_name,
        artifactName: p.artifact_name,
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
