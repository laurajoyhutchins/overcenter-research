import type {
  GithubHostileMutationEvidencePostcondition,
  Observation,
} from '../../model.ts';
import { canonicalDigest, sha256 } from '../../digest.ts';
import {
  readGithubEvidenceFile,
  verifyGithubRepositoryIdentity,
  verifyGithubWorkflowArtifact,
} from './evidence-primitives.ts';
import { githubGet, type GithubJsonGet } from './rest.ts';

const WORKFLOW_PATH = '.github/workflows/production-criticality-mutation-probe.yml';
const JOB_NAME = 'mutate';
const ARTIFACT_NAME = 'production-criticality-mutation-probe';

const data = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function sourceRunKey(source: Record<string, unknown>): string {
  const runId = source.workflow_run_id;
  if (!Number.isSafeInteger(runId) || Number(runId) <= 0) {
    throw new Error('GITHUB_HOSTILE_EVIDENCE_RUN_ID_INVALID');
  }
  if (typeof source.revision !== 'string' || !/^[0-9a-f]{40}$/i.test(source.revision)) {
    throw new Error('GITHUB_HOSTILE_EVIDENCE_REVISION_INVALID');
  }
  if (
    typeof source.artifact_digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/i.test(source.artifact_digest)
  ) {
    throw new Error('GITHUB_HOSTILE_EVIDENCE_ARTIFACT_DIGEST_INVALID');
  }
  return `${runId}:${source.revision.toLowerCase()}:${source.artifact_digest.toLowerCase()}`;
}

function committedSourceBindings(value: unknown): {
  sourceBlobs: Record<string, string>;
  sources: Record<string, unknown>[];
} {
  if (!data(value) || value.schema !== 'overcenter-criticality-mutation-evidence') {
    throw new Error('GITHUB_HOSTILE_EVIDENCE_SCHEMA_INVALID');
  }
  if (!Array.isArray(value.probes) || value.probes.length === 0) {
    throw new Error('GITHUB_HOSTILE_EVIDENCE_PROBES_INVALID');
  }

  const sourceBlobs: Record<string, string> = {};
  const sources = new Map<string, Record<string, unknown>>();
  for (const probe of value.probes) {
    if (!data(probe) || typeof probe.id !== 'string' || !data(probe.source_blobs)) {
      throw new Error('GITHUB_HOSTILE_EVIDENCE_PROBE_INVALID');
    }
    for (const [path, blob] of Object.entries(probe.source_blobs)) {
      if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/i.test(blob)) {
        throw new Error(`GITHUB_HOSTILE_EVIDENCE_SOURCE_BLOB_INVALID:${path}`);
      }
      const normalized = blob.toLowerCase();
      const prior = sourceBlobs[path];
      if (prior && prior !== normalized) {
        throw new Error(`GITHUB_HOSTILE_EVIDENCE_SOURCE_BLOB_CONFLICT:${path}`);
      }
      sourceBlobs[path] = normalized;
    }
    if (!data(probe.source_run)) throw new Error('GITHUB_HOSTILE_EVIDENCE_SOURCE_RUN_INVALID');
    sources.set(sourceRunKey(probe.source_run), probe.source_run);
  }
  return { sourceBlobs, sources: [...sources.values()] };
}

function common(p: GithubHostileMutationEvidencePostcondition) {
  return {
    verifier: p.verifier,
    provider: 'github' as const,
    repository_id: p.repository_id,
    repository_full_name: p.repository_full_name,
    ref: p.ref,
    evidence_path: p.evidence_path,
    expected_sha256: p.expected_sha256,
    source_binding_sha256: canonicalDigest(p.source_blobs),
  };
}

export function observeGithubHostileMutationEvidence(
  token: string,
  p: GithubHostileMutationEvidencePostcondition,
  get: GithubJsonGet = githubGet,
): Observation {
  const base = common(p);
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

    let committed: unknown;
    try {
      committed = JSON.parse(evidenceFile.bytes.toString('utf8'));
    } catch {
      throw new Error('GITHUB_HOSTILE_EVIDENCE_JSON_INVALID');
    }

    const bindings = committedSourceBindings(committed);
    const expectedPaths = Object.keys(p.source_blobs).sort();
    const committedPaths = Object.keys(bindings.sourceBlobs).sort();
    const sourceEvidence: Record<string, unknown> = {};
    let current =
      actualSha256 === p.expected_sha256 &&
      JSON.stringify(expectedPaths) === JSON.stringify(committedPaths);

    for (const path of expectedPaths) {
      const expected = p.source_blobs[path]!.toLowerCase();
      const committedBlob = bindings.sourceBlobs[path];
      const observed = readGithubEvidenceFile(token, {
        repositoryFullName: p.repository_full_name,
        path,
        ref: p.ref,
        get,
      }).blob;
      sourceEvidence[path] = {
        expected_blob: expected,
        committed_evidence_blob: committedBlob ?? null,
        observed_blob: observed,
      };
      if (committedBlob !== expected || observed !== expected) current = false;
    }

    const sourceRuns = bindings.sources.map((source) =>
      verifyGithubWorkflowArtifact(token, {
        repositoryFullName: p.repository_full_name,
        workflowRunId: Number(source.workflow_run_id),
        revision: String(source.revision),
        workflowPath: WORKFLOW_PATH,
        jobName: JOB_NAME,
        artifactName: ARTIFACT_NAME,
        artifactDigest: String(source.artifact_digest),
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
