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

const data = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

interface SourceRun {
  workflow_run_id: number;
  revision: string;
  artifact_digest: string;
}

interface SourceBoundBinding {
  source_blobs: Record<string, string>;
  evidence_source_blobs: Record<string, string>;
  source_runs: SourceRun[];
  workflow: {
    path: string;
    job: string;
    artifact: string;
  };
}

function blobMap(value: unknown): Record<string, string> | null {
  if (!data(value)) return null;
  const entries = Object.entries(value);
  if (
    !entries.every(
      ([path, blob]) =>
        path.length > 0 &&
        !path.startsWith('/') &&
        !path.split('/').some((part) => part === '' || part === '.' || part === '..') &&
        typeof blob === 'string' &&
        /^[0-9a-f]{40}$/i.test(blob),
    )
  ) {
    return null;
  }
  return Object.fromEntries(entries.map(([path, blob]) => [path, String(blob).toLowerCase()]));
}

function sourceBoundBinding(p: GithubSourceBoundEvidencePostcondition): SourceBoundBinding {
  const binding = p.binding;
  const sourceBlobs = blobMap(binding.source_blobs);
  const evidenceSourceBlobs = blobMap(binding.evidence_source_blobs);
  const runs = binding.source_runs;
  const workflow = binding.workflow;
  if (
    !sourceBlobs ||
    Object.keys(sourceBlobs).length === 0 ||
    !evidenceSourceBlobs ||
    !Array.isArray(runs) ||
    !data(workflow) ||
    typeof workflow.path !== 'string' ||
    workflow.path.length === 0 ||
    typeof workflow.job !== 'string' ||
    workflow.job.length === 0 ||
    typeof workflow.artifact !== 'string' ||
    workflow.artifact.length === 0
  ) {
    throw new Error('GITHUB_SOURCE_BOUND_EVIDENCE_BINDING_INVALID');
  }

  const sourceRuns: SourceRun[] = [];
  for (const run of runs) {
    if (
      !data(run) ||
      !Number.isSafeInteger(run.workflow_run_id) ||
      Number(run.workflow_run_id) <= 0 ||
      typeof run.revision !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(run.revision) ||
      typeof run.artifact_digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/i.test(run.artifact_digest)
    ) {
      throw new Error('GITHUB_SOURCE_BOUND_EVIDENCE_RUN_INVALID');
    }
    sourceRuns.push({
      workflow_run_id: Number(run.workflow_run_id),
      revision: run.revision.toLowerCase(),
      artifact_digest: run.artifact_digest.toLowerCase(),
    });
  }
  if (sourceRuns.length === 0) throw new Error('GITHUB_SOURCE_BOUND_EVIDENCE_RUNS_MISSING');

  return {
    source_blobs: sourceBlobs,
    evidence_source_blobs: evidenceSourceBlobs,
    source_runs: sourceRuns,
    workflow: {
      path: workflow.path,
      job: workflow.job,
      artifact: workflow.artifact,
    },
  };
}

export function githubSourceBoundEvidenceBindingDigest(
  p: GithubSourceBoundEvidencePostcondition,
): string {
  return canonicalDigest(p.binding);
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
    const binding = sourceBoundBinding(p);
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

    const expectedPaths = Object.keys(binding.source_blobs).sort();
    const evidencePaths = Object.keys(binding.evidence_source_blobs).sort();
    const sourceEvidence: Record<string, unknown> = {};
    let current =
      actualSha256 === p.expected_sha256 &&
      JSON.stringify(expectedPaths) === JSON.stringify(evidencePaths);

    for (const path of expectedPaths) {
      const expected = binding.source_blobs[path]!;
      const declared = binding.evidence_source_blobs[path];
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

    const sourceRuns = binding.source_runs.map((source) =>
      verifyGithubWorkflowArtifact(token, {
        repositoryFullName: p.repository_full_name,
        workflowRunId: source.workflow_run_id,
        revision: source.revision,
        workflowPath: binding.workflow.path,
        jobName: binding.workflow.job,
        artifactName: binding.workflow.artifact,
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
