import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import type { Obligation } from '../model.ts';
import { normalizeObligation } from '../authority/facts.ts';

export const HOSTILE_MUTATION_EVIDENCE_OBLIGATION_ID = 'hostile-mutation-evidence-current' as const;
export const HOSTILE_MUTATION_EVIDENCE_PACKET_SCHEMA =
  'overcenter-hostile-mutation-evidence-obligation/v1' as const;
export const HOSTILE_MUTATION_EVIDENCE_PATH =
  'experiments/production-criticality-ranking/mutation-evidence.json' as const;
export const HOSTILE_MUTATION_PROBES_PATH =
  'experiments/production-criticality-ranking/mutation-probes.json' as const;

function gitBytes(repo: string, sourceSha: string, path: string): Buffer {
  return execFileSync('git', ['-C', repo, 'show', `${sourceSha}:${path}`], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

function gitBlob(repo: string, sourceSha: string, path: string): string {
  const raw = execFileSync('git', ['-C', repo, 'ls-tree', sourceSha, '--', path], {
    encoding: 'utf8',
  }).trim();
  const match = raw.match(/^100(?:644|755) blob ([0-9a-f]{40})\t(.+)$/);
  if (!match || match[2] !== path) {
    throw new Error(`HOSTILE_MUTATION_SOURCE_BLOB_MISSING:${path}`);
  }
  return match[1]!;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function probeSources(raw: unknown): { probeIds: string[]; paths: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('HOSTILE_MUTATION_PROBES_INVALID');
  }
  const probes = (raw as { probes?: unknown }).probes;
  if (!Array.isArray(probes) || probes.length === 0) {
    throw new Error('HOSTILE_MUTATION_PROBES_INVALID');
  }
  const probeIds: string[] = [];
  const paths = new Set<string>();
  for (const probe of probes) {
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
      throw new Error('HOSTILE_MUTATION_PROBE_INVALID');
    }
    const candidate = probe as {
      id?: unknown;
      selectors?: unknown;
    };
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      throw new Error('HOSTILE_MUTATION_PROBE_ID_INVALID');
    }
    if (!Array.isArray(candidate.selectors) || candidate.selectors.length === 0) {
      throw new Error(`HOSTILE_MUTATION_PROBE_SELECTORS_INVALID:${candidate.id}`);
    }
    probeIds.push(candidate.id);
    for (const selector of candidate.selectors) {
      if (
        !selector ||
        typeof selector !== 'object' ||
        Array.isArray(selector) ||
        typeof (selector as { file?: unknown }).file !== 'string'
      ) {
        throw new Error(`HOSTILE_MUTATION_PROBE_SELECTOR_INVALID:${candidate.id}`);
      }
      paths.add((selector as { file: string }).file);
    }
  }
  probeIds.sort();
  return { probeIds, paths: [...paths].sort() };
}

export function compileHostileMutationEvidenceObligation({
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
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) {
    throw new Error('HOSTILE_MUTATION_SOURCE_REVISION_INVALID');
  }
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error('HOSTILE_MUTATION_REPOSITORY_ID_INVALID');
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repositoryFullName)) {
    throw new Error('HOSTILE_MUTATION_REPOSITORY_INVALID');
  }
  if (ref.length === 0) throw new Error('HOSTILE_MUTATION_REF_INVALID');

  const configured = probeSources(
    JSON.parse(gitBytes(repo, sourceSha, HOSTILE_MUTATION_PROBES_PATH).toString('utf8')),
  );
  const evidenceBytes = gitBytes(repo, sourceSha, HOSTILE_MUTATION_EVIDENCE_PATH);
  const sourceBlobs = Object.fromEntries(
    configured.paths.map((path) => [path, gitBlob(repo, sourceSha, path)]),
  );

  return normalizeObligation({
    id: HOSTILE_MUTATION_EVIDENCE_OBLIGATION_ID,
    packet: {
      schema: HOSTILE_MUTATION_EVIDENCE_PACKET_SCHEMA,
      kind: 'system-evidence',
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

export function isSystemEvidenceObligation(work: { packet: Record<string, unknown> }): boolean {
  return (
    work.packet.schema === HOSTILE_MUTATION_EVIDENCE_PACKET_SCHEMA &&
    work.packet.kind === 'system-evidence'
  );
}
