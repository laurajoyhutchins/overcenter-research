import type { Obligation } from '../model.ts';
import { normalizeObligation } from '../authority/facts.ts';
import type { ProjectGraphProducer } from '../authority/project-graph.ts';
import { sha256 } from '../digest.ts';
import { repositorySnapshot, type RepositorySnapshot } from './repository-snapshot.ts';
import { SYSTEM_EVIDENCE_KIND, SYSTEM_EVIDENCE_PACKET_SCHEMA } from './system-evidence.ts';

export const HOSTILE_MUTATION_EVIDENCE_OBLIGATION_ID = 'hostile-mutation-evidence-current' as const;
export const HOSTILE_MUTATION_EVIDENCE_PATH =
  'experiments/production-criticality-ranking/mutation-evidence.json' as const;
export const HOSTILE_MUTATION_PROBES_PATH =
  'experiments/production-criticality-ranking/mutation-probes.json' as const;

const WORKFLOW_PATH = '.github/workflows/production-criticality-mutation-probe.yml';
const JOB_NAME = 'mutate';
const ARTIFACT_NAME = 'production-criticality-mutation-probe';

const data = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function probeSources(raw: unknown): { probeIds: string[]; paths: string[] } {
  if (!data(raw) || !Array.isArray(raw.probes) || raw.probes.length === 0) {
    throw new Error('HOSTILE_MUTATION_PROBES_INVALID');
  }

  const probeIds: string[] = [];
  const paths = new Set<string>();
  for (const probe of raw.probes) {
    if (!data(probe) || typeof probe.id !== 'string' || !Array.isArray(probe.selectors)) {
      throw new Error('HOSTILE_MUTATION_PROBE_INVALID');
    }
    if (probe.id.length === 0 || probe.selectors.length === 0) {
      throw new Error(`HOSTILE_MUTATION_PROBE_SELECTORS_INVALID:${probe.id}`);
    }

    probeIds.push(probe.id);
    for (const selector of probe.selectors) {
      if (!data(selector) || typeof selector.file !== 'string') {
        throw new Error(`HOSTILE_MUTATION_PROBE_SELECTOR_INVALID:${probe.id}`);
      }
      paths.add(selector.file);
    }
  }

  return { probeIds: probeIds.sort(), paths: [...paths].sort() };
}

function evidenceBindings(bytes: Buffer): {
  sourceBlobs: Record<string, string>;
  sourceRuns: Array<{
    workflow_run_id: number;
    revision: string;
    artifact_digest: string;
  }>;
} {
  try {
    const raw = JSON.parse(bytes.toString('utf8'));
    if (
      !data(raw) ||
      raw.schema !== 'overcenter-criticality-mutation-evidence' ||
      !Array.isArray(raw.probes)
    ) {
      return { sourceBlobs: {}, sourceRuns: [] };
    }

    const sourceBlobs: Record<string, string> = {};
    const sourceRuns = new Map<
      string,
      { workflow_run_id: number; revision: string; artifact_digest: string }
    >();

    for (const probe of raw.probes) {
      if (!data(probe) || !data(probe.source_blobs) || !data(probe.source_run)) {
        return { sourceBlobs: {}, sourceRuns: [] };
      }
      for (const [path, blob] of Object.entries(probe.source_blobs)) {
        if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/i.test(blob)) {
          return { sourceBlobs: {}, sourceRuns: [] };
        }
        const normalized = blob.toLowerCase();
        if (sourceBlobs[path] && sourceBlobs[path] !== normalized) {
          return { sourceBlobs: {}, sourceRuns: [] };
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
        return { sourceBlobs: {}, sourceRuns: [] };
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

    return { sourceBlobs, sourceRuns: [...sourceRuns.values()] };
  } catch {
    return { sourceBlobs: {}, sourceRuns: [] };
  }
}

export function compileHostileMutationEvidenceObligation({
  snapshot,
  repositoryId,
  repositoryFullName,
  ref = 'main',
}: {
  snapshot: RepositorySnapshot;
  repositoryId: number;
  repositoryFullName: string;
  ref?: string;
}): Obligation {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error('HOSTILE_MUTATION_REPOSITORY_ID_INVALID');
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repositoryFullName)) {
    throw new Error('HOSTILE_MUTATION_REPOSITORY_INVALID');
  }
  if (ref.length === 0) throw new Error('HOSTILE_MUTATION_REF_INVALID');

  const configured = probeSources(
    JSON.parse(snapshot.bytes(HOSTILE_MUTATION_PROBES_PATH).toString('utf8')),
  );
  const evidenceBytes = snapshot.bytes(HOSTILE_MUTATION_EVIDENCE_PATH);
  const currentSourceBlobs = Object.fromEntries(
    configured.paths.map((path) => [path, snapshot.blob(path)]),
  );
  const committed = evidenceBindings(evidenceBytes);

  return normalizeObligation({
    id: HOSTILE_MUTATION_EVIDENCE_OBLIGATION_ID,
    packet: {
      schema: SYSTEM_EVIDENCE_PACKET_SCHEMA,
      kind: SYSTEM_EVIDENCE_KIND,
      evidence_kind: 'hostile-mutation',
      evidence_path: HOSTILE_MUTATION_EVIDENCE_PATH,
      probe_ids: configured.probeIds,
      source_blobs: currentSourceBlobs,
    },
    postcondition: {
      verifier: 'github-source-bound-evidence/v1',
      provider: 'github',
      repository_id: repositoryId,
      repository_full_name: repositoryFullName,
      ref,
      evidence_path: HOSTILE_MUTATION_EVIDENCE_PATH,
      expected_sha256: sha256(evidenceBytes),
      source_blobs: currentSourceBlobs,
      evidence_source_blobs: committed.sourceBlobs,
      source_runs: committed.sourceRuns,
      workflow_path: WORKFLOW_PATH,
      job_name: JOB_NAME,
      artifact_name: ARTIFACT_NAME,
    },
  });
}

export function compileHostileMutationEvidenceFromRepository({
  repo,
  sourceSha,
  repositoryId,
  repositoryFullName,
  ref = 'main',
}: {
  repo: string;
  sourceSha: string;
  repositoryId: number;
  repositoryFullName: string;
  ref?: string;
}): Obligation {
  return compileHostileMutationEvidenceObligation({
    snapshot: repositorySnapshot(repo, sourceSha),
    repositoryId,
    repositoryFullName,
    ref,
  });
}

export const hostileMutationEvidenceGraphProducer: ProjectGraphProducer = Object.freeze({
  id: 'hostile-mutation-evidence',
  input_paths: [HOSTILE_MUTATION_PROBES_PATH, HOSTILE_MUTATION_EVIDENCE_PATH],
  produce(snapshot, context) {
    return [
      compileHostileMutationEvidenceObligation({
        snapshot,
        repositoryId: context.repository_id,
        repositoryFullName: context.repository_full_name,
      }),
    ];
  },
});
