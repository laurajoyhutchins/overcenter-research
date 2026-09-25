import type { GithubHostileMutationEvidencePostcondition, Observation } from '../../model.ts';
import {
  observeGithubSourceBoundEvidence,
  type GithubSourceBoundEvidenceBinding,
} from './source-bound-evidence.ts';
import { githubGet, type GithubJsonGet } from './rest.ts';

const WORKFLOW_PATH = '.github/workflows/production-criticality-mutation-probe.yml';
const JOB_NAME = 'mutate';
const ARTIFACT_NAME = 'production-criticality-mutation-probe';

const data = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function mutationEvidenceBinding(bytes: Buffer): GithubSourceBoundEvidenceBinding {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('GITHUB_HOSTILE_EVIDENCE_JSON_INVALID');
  }
  if (
    !data(value) ||
    value.schema !== 'overcenter-criticality-mutation-evidence' ||
    !Array.isArray(value.probes) ||
    value.probes.length === 0
  ) {
    throw new Error('GITHUB_HOSTILE_EVIDENCE_SCHEMA_INVALID');
  }

  const sourceBlobs: Record<string, string> = {};
  const sourceRuns = new Map<
    string,
    { workflow_run_id: number; revision: string; artifact_digest: string }
  >();

  for (const probe of value.probes) {
    if (!data(probe) || !data(probe.source_blobs) || !data(probe.source_run)) {
      throw new Error('GITHUB_HOSTILE_EVIDENCE_PROBE_INVALID');
    }
    for (const [path, blob] of Object.entries(probe.source_blobs)) {
      if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/i.test(blob)) {
        throw new Error(`GITHUB_HOSTILE_EVIDENCE_SOURCE_BLOB_INVALID:${path}`);
      }
      const normalized = blob.toLowerCase();
      if (sourceBlobs[path] && sourceBlobs[path] !== normalized) {
        throw new Error(`GITHUB_HOSTILE_EVIDENCE_SOURCE_BLOB_CONFLICT:${path}`);
      }
      sourceBlobs[path] = normalized;
    }

    const runId = probe.source_run.workflow_run_id;
    const revision = probe.source_run.revision;
    const artifactDigest = probe.source_run.artifact_digest;
    if (
      !Number.isSafeInteger(runId) ||
      Number(runId) <= 0 ||
      typeof revision !== 'string' ||
      !/^[0-9a-f]{40}$/i.test(revision) ||
      typeof artifactDigest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/i.test(artifactDigest)
    ) {
      throw new Error('GITHUB_HOSTILE_EVIDENCE_SOURCE_RUN_INVALID');
    }
    const sourceRun = {
      workflow_run_id: Number(runId),
      revision: revision.toLowerCase(),
      artifact_digest: artifactDigest.toLowerCase(),
    };
    sourceRuns.set(
      `${sourceRun.workflow_run_id}:${sourceRun.revision}:${sourceRun.artifact_digest}`,
      sourceRun,
    );
  }

  return { source_blobs: sourceBlobs, source_runs: [...sourceRuns.values()] };
}

export function observeGithubHostileMutationEvidence(
  token: string,
  p: GithubHostileMutationEvidencePostcondition,
  get: GithubJsonGet = githubGet,
): Observation {
  return observeGithubSourceBoundEvidence(
    token,
    p,
    {
      workflow_path: WORKFLOW_PATH,
      job_name: JOB_NAME,
      artifact_name: ARTIFACT_NAME,
      bindingFromEvidence: mutationEvidenceBinding,
    },
    get,
  );
}
