import type { Obligation } from '../model.ts';
import { normalizeObligation } from '../authority/facts.ts';
import type { ProjectGraphContext, ProjectGraphProducer } from '../authority/project-graph.ts';
import { sha256 } from '../digest.ts';
import { repositorySnapshot, type RepositorySnapshot } from './repository-snapshot.ts';
import { SYSTEM_EVIDENCE_KIND, SYSTEM_EVIDENCE_PACKET_SCHEMA } from './system-evidence.ts';

export const HOSTILE_MUTATION_EVIDENCE_OBLIGATION_ID = 'hostile-mutation-evidence-current' as const;
export const HOSTILE_MUTATION_EVIDENCE_PATH =
  'experiments/production-criticality-ranking/mutation-evidence.json' as const;
export const HOSTILE_MUTATION_PROBES_PATH =
  'experiments/production-criticality-ranking/mutation-probes.json' as const;

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
  const sourceBlobs = Object.fromEntries(
    configured.paths.map((sourcePath) => [sourcePath, snapshot.blob(sourcePath)]),
  );

  return normalizeObligation({
    id: HOSTILE_MUTATION_EVIDENCE_OBLIGATION_ID,
    packet: {
      schema: SYSTEM_EVIDENCE_PACKET_SCHEMA,
      kind: SYSTEM_EVIDENCE_KIND,
      evidence_kind: 'hostile-mutation',
      evidence_path: HOSTILE_MUTATION_EVIDENCE_PATH,
      probe_ids: configured.probeIds,
      source_blobs: sourceBlobs,
    },
    postcondition: {
      verifier: 'github-hostile-mutation-evidence/v1',
      provider: 'github',
      repository_id: repositoryId,
      repository_full_name: repositoryFullName,
      ref,
      evidence_path: HOSTILE_MUTATION_EVIDENCE_PATH,
      expected_sha256: sha256(evidenceBytes),
      source_blobs: sourceBlobs,
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
  produce(snapshot: RepositorySnapshot, context: ProjectGraphContext) {
    return [
      compileHostileMutationEvidenceObligation({
        snapshot,
        repositoryId: context.repository_id,
        repositoryFullName: context.repository_full_name,
      }),
    ];
  },
});
