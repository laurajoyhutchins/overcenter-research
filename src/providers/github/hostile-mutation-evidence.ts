import { createHash } from 'node:crypto';

import type { GithubHostileMutationEvidencePostcondition, Observation } from '../../model.ts';
import { canonicalDigest } from '../../digest.ts';
import type { GithubJsonGet } from './rest.ts';

const WORKFLOW_PATH = '.github/workflows/production-criticality-mutation-probe.yml';
const ARTIFACT_NAME = 'production-criticality-mutation-probe';

const data = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

function apiPath(repositoryFullName: string, suffix: string): string {
  const [owner, repo] = repositoryFullName.split('/');
  return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}${suffix}`;
}

function contentPath(repositoryFullName: string, path: string, ref: string): string {
  const encoded = path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return apiPath(repositoryFullName, `/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
}

function fileBytes(
  token: string,
  repositoryFullName: string,
  path: string,
  ref: string,
  get: GithubJsonGet,
): { bytes: Buffer; blob: string } {
  const raw = get(token, contentPath(repositoryFullName, path, ref));
  if (
    !data(raw) ||
    raw.type !== 'file' ||
    typeof raw.sha !== 'string' ||
    raw.encoding !== 'base64' ||
    typeof raw.content !== 'string'
  ) {
    throw new Error(`GITHUB_HOSTILE_EVIDENCE_FILE_INVALID:${path}`);
  }
  return {
    bytes: Buffer.from(raw.content.replace(/\s/g, ''), 'base64'),
    blob: raw.sha,
  };
}

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
      const prior = sourceBlobs[path];
      if (prior && prior.toLowerCase() !== blob.toLowerCase()) {
        throw new Error(`GITHUB_HOSTILE_EVIDENCE_SOURCE_BLOB_CONFLICT:${path}`);
      }
      sourceBlobs[path] = blob.toLowerCase();
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
  get: GithubJsonGet,
): Observation {
  const base = common(p);
  try {
    const repository = get(token, apiPath(p.repository_full_name, ''));
    if (
      !data(repository) ||
      repository.id !== p.repository_id ||
      typeof repository.full_name !== 'string' ||
      repository.full_name.toLowerCase() !== p.repository_full_name.toLowerCase()
    ) {
      return {
        ...base,
        mutation_certainty: 'uncertain',
        observation_error: 'GITHUB_HOSTILE_EVIDENCE_REPOSITORY_IDENTITY_MISMATCH',
      };
    }

    const evidenceFile = fileBytes(token, p.repository_full_name, p.evidence_path, p.ref, get);
    const actualSha256 = sha256(evidenceFile.bytes);
    let committed: unknown;
    try {
      committed = JSON.parse(evidenceFile.bytes.toString('utf8'));
    } catch {
      return {
        ...base,
        actual_sha256: actualSha256,
        mutation_certainty: 'uncertain',
        observation_error: 'GITHUB_HOSTILE_EVIDENCE_JSON_INVALID',
      };
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
      const observed = fileBytes(
        token,
        p.repository_full_name,
        path,
        p.ref,
        get,
      ).blob.toLowerCase();
      sourceEvidence[path] = {
        expected_blob: expected,
        committed_evidence_blob: committedBlob ?? null,
        observed_blob: observed,
      };
      if (committedBlob !== expected || observed !== expected) current = false;
    }

    const runEvidence: unknown[] = [];
    for (const source of bindings.sources) {
      const runId = Number(source.workflow_run_id);
      const revision = String(source.revision).toLowerCase();
      const artifactDigest = String(source.artifact_digest).toLowerCase();
      const run = get(token, apiPath(p.repository_full_name, `/actions/runs/${runId}`));
      if (
        !data(run) ||
        run.path !== WORKFLOW_PATH ||
        typeof run.head_sha !== 'string' ||
        run.head_sha.toLowerCase() !== revision ||
        run.conclusion !== 'success'
      ) {
        return {
          ...base,
          actual_sha256: actualSha256,
          mutation_certainty: 'uncertain',
          observation_error: `GITHUB_HOSTILE_EVIDENCE_RUN_INVALID:${runId}`,
        };
      }
      const jobs = get(
        token,
        apiPath(p.repository_full_name, `/actions/runs/${runId}/jobs?per_page=100`),
      );
      const mutate =
        data(jobs) && Array.isArray(jobs.jobs)
          ? jobs.jobs.find((job) => data(job) && job.name === 'mutate')
          : null;
      if (!data(mutate) || mutate.conclusion !== 'success') {
        return {
          ...base,
          actual_sha256: actualSha256,
          mutation_certainty: 'uncertain',
          observation_error: `GITHUB_HOSTILE_EVIDENCE_MUTATE_JOB_INVALID:${runId}`,
        };
      }
      const artifacts = get(
        token,
        apiPath(p.repository_full_name, `/actions/runs/${runId}/artifacts?per_page=100`),
      );
      const artifact =
        data(artifacts) && Array.isArray(artifacts.artifacts)
          ? artifacts.artifacts.find(
              (item) =>
                data(item) &&
                item.name === ARTIFACT_NAME &&
                item.expired === false &&
                typeof item.digest === 'string',
            )
          : null;
      if (!data(artifact) || String(artifact.digest).toLowerCase() !== artifactDigest) {
        return {
          ...base,
          actual_sha256: actualSha256,
          mutation_certainty: 'uncertain',
          observation_error: `GITHUB_HOSTILE_EVIDENCE_ARTIFACT_INVALID:${runId}`,
        };
      }
      runEvidence.push({
        workflow_run_id: runId,
        revision,
        artifact_digest: artifactDigest,
      });
    }

    return {
      ...base,
      actual_sha256: actualSha256,
      actual_state: current ? 'current' : 'stale',
      mutation_certainty: 'present',
      provider_evidence: {
        evidence_blob: evidenceFile.blob,
        source_blobs: sourceEvidence,
        source_runs: runEvidence,
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
