import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalDigest } from '../../src/digest.ts';
import { FileEvidenceStore } from '../../src/evidence/file-store.ts';
import { evidenceRef, type EvidenceRef } from '../../src/evidence/reference.ts';

interface ClaimContext {
  assignment_sha256: string;
  run_id: string;
  claimed_revision: string;
  source_revision: string;
  writable_paths: string[];
}

interface Candidate {
  assignment_sha256: string;
  run_id: string;
  claimed_revision: string;
  source_revision: string;
  artifact_base64: string;
}

interface SourceArtifact {
  files: Array<{ path: string; content: string }>;
}

interface VerifiedOutputReceipt {
  schema: 'experiment-verified-generated-output/v1';
  run_id: string;
  claimed_revision: string;
  source_revision: string;
  verifier: 'source-proposal-scope/v1';
  artifact: EvidenceRef;
  changed_paths: string[];
}

interface Settlement {
  commit: string;
  parent: string;
  receipt: VerifiedOutputReceipt;
}

class Authority {
  head = 'authority-root';
  readonly settlements = new Map<string, Settlement>();

  append(expectedHead: string, receipt: VerifiedOutputReceipt): Settlement | null {
    if (expectedHead !== this.head) return null;
    const commit = canonicalDigest({
      domain: 'experiment-generated-output-settlement',
      parent: expectedHead,
      receipt,
    });
    const settlement = { commit, parent: expectedHead, receipt: structuredClone(receipt) };
    this.settlements.set(commit, settlement);
    this.head = commit;
    return settlement;
  }
}

function validPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')) return false;
  return value
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git');
}

function decodeArtifact(candidate: Candidate): { bytes: Buffer; artifact: SourceArtifact } {
  const bytes = Buffer.from(candidate.artifact_base64, 'base64');
  if (bytes.toString('base64') !== candidate.artifact_base64) {
    throw new Error('CANDIDATE_ARTIFACT_BASE64_INVALID');
  }
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CANDIDATE_ARTIFACT_INVALID');
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'files') throw new Error('CANDIDATE_ARTIFACT_SHAPE_INVALID');
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) throw new Error('CANDIDATE_FILES_INVALID');

  const seen = new Set<string>();
  const normalized: SourceArtifact['files'] = [];
  for (const item of files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('CANDIDATE_FILE_INVALID');
    }
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'content,path' ||
      !validPath(record.path) ||
      typeof record.content !== 'string'
    ) {
      throw new Error('CANDIDATE_FILE_INVALID');
    }
    if (seen.has(record.path)) throw new Error('CANDIDATE_FILE_DUPLICATE');
    seen.add(record.path);
    normalized.push({ path: record.path, content: record.content });
  }
  normalized.sort((a, b) => a.path.localeCompare(b.path));
  return { bytes, artifact: { files: normalized } };
}

function candidateBytes(artifact: SourceArtifact): string {
  const normalized = {
    files: [...artifact.files]
      .map((file) => ({ path: file.path, content: file.content }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  return Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64');
}

function validateBinding(candidate: Candidate, claim: ClaimContext): void {
  for (const [key, expected] of [
    ['assignment_sha256', claim.assignment_sha256],
    ['run_id', claim.run_id],
    ['claimed_revision', claim.claimed_revision],
    ['source_revision', claim.source_revision],
  ] as const) {
    if (candidate[key] !== expected) throw new Error(`CANDIDATE_BINDING_MISMATCH:${key}`);
  }
}

function validatePublishAndSettle(
  candidate: Candidate,
  claim: ClaimContext,
  store: FileEvidenceStore,
  authority: Authority,
  expectedHead: string,
): Settlement | null {
  validateBinding(candidate, claim);
  const decoded = decodeArtifact(candidate);
  const changedPaths = decoded.artifact.files.map((file) => file.path);
  if (changedPaths.some((path) => !claim.writable_paths.includes(path))) {
    throw new Error('CANDIDATE_SOURCE_SCOPE_VIOLATION');
  }

  // Evidence publication deliberately precedes authority publication.
  const artifact = store.put(decoded.bytes);
  const receipt: VerifiedOutputReceipt = {
    schema: 'experiment-verified-generated-output/v1',
    run_id: claim.run_id,
    claimed_revision: claim.claimed_revision,
    source_revision: claim.source_revision,
    verifier: 'source-proposal-scope/v1',
    artifact,
    changed_paths: [...changedPaths].sort(),
  };
  return authority.append(expectedHead, receipt);
}

function consume(
  settlement: Settlement,
  store: FileEvidenceStore,
): { bytes: Buffer; downstream_identity: string } {
  const bytes = Buffer.from(store.get(settlement.receipt.artifact));
  const downstreamIdentity = canonicalDigest({
    id: 'source-integration',
    semantic_dependencies: [
      {
        consumes: { kind: 'evidence', selector: 'settlement-receipt' },
        identity: `settlement:${settlement.commit}`,
      },
    ],
  });
  return { bytes, downstream_identity: downstreamIdentity };
}

const claim: ClaimContext = {
  assignment_sha256: 'a'.repeat(64),
  run_id: 'run-source-proposal',
  claimed_revision: 'authority-claim',
  source_revision: 'b'.repeat(40),
  writable_paths: ['src/feature.ts', 'test/feature.test.ts'],
};

const root = mkdtempSync(join(tmpdir(), 'overcenter-verified-generated-output-'));
try {
  const store = new FileEvidenceStore(join(root, 'evidence'));

  const ordinaryAuthority = new Authority();
  const ordinaryCandidate: Candidate = {
    assignment_sha256: claim.assignment_sha256,
    run_id: claim.run_id,
    claimed_revision: claim.claimed_revision,
    source_revision: claim.source_revision,
    artifact_base64: candidateBytes({
      files: [{ path: 'src/feature.ts', content: 'export const enabled = true;\n' }],
    }),
  };
  const ordinary = validatePublishAndSettle(
    ordinaryCandidate,
    claim,
    store,
    ordinaryAuthority,
    ordinaryAuthority.head,
  );
  assert.ok(ordinary);
  const ordinaryConsumed = consume(ordinary, store);
  assert.deepEqual(
    JSON.parse(ordinaryConsumed.bytes.toString('utf8')),
    JSON.parse(Buffer.from(ordinaryCandidate.artifact_base64, 'base64').toString('utf8')),
  );

  const alternateAuthority = new Authority();
  const alternateCandidate: Candidate = {
    ...ordinaryCandidate,
    artifact_base64: candidateBytes({
      files: [{ path: 'src/feature.ts', content: 'export const enabled = false;\n' }],
    }),
  };
  const alternate = validatePublishAndSettle(
    alternateCandidate,
    claim,
    store,
    alternateAuthority,
    alternateAuthority.head,
  );
  assert.ok(alternate);
  assert.notDeepEqual(ordinary.receipt.artifact, alternate.receipt.artifact);
  assert.notEqual(ordinary.commit, alternate.commit);
  assert.notEqual(
    ordinaryConsumed.downstream_identity,
    consume(alternate, store).downstream_identity,
  );

  for (const [field, value] of [
    ['assignment_sha256', 'c'.repeat(64)],
    ['run_id', 'other-run'],
    ['claimed_revision', 'stale-authority'],
    ['source_revision', 'd'.repeat(40)],
  ] as const) {
    const authority = new Authority();
    const before = authority.head;
    const forged = { ...ordinaryCandidate, [field]: value };
    assert.throws(
      () => validatePublishAndSettle(forged, claim, store, authority, before),
      new RegExp(`CANDIDATE_BINDING_MISMATCH:${field}`),
    );
    assert.equal(authority.head, before);
  }

  const scopeAuthority = new Authority();
  const scopeBefore = scopeAuthority.head;
  assert.throws(
    () =>
      validatePublishAndSettle(
        {
          ...ordinaryCandidate,
          artifact_base64: candidateBytes({
            files: [{ path: 'src/undeclared.ts', content: 'hostile\n' }],
          }),
        },
        claim,
        store,
        scopeAuthority,
        scopeBefore,
      ),
    /CANDIDATE_SOURCE_SCOPE_VIOLATION/,
  );
  assert.equal(scopeAuthority.head, scopeBefore);

  // Crash after evidence publication leaves only an orphan immutable object.
  const orphanBytes = Buffer.from(
    candidateBytes({
      files: [{ path: 'src/feature.ts', content: 'orphan\n' }],
    }),
    'base64',
  );
  const orphanAuthority = new Authority();
  const orphanHead = orphanAuthority.head;
  const orphanRef = store.put(orphanBytes);
  assert.deepEqual(store.get(orphanRef), orphanBytes);
  assert.equal(orphanAuthority.head, orphanHead);
  assert.equal(orphanAuthority.settlements.size, 0);

  // Competing verified outputs may both publish bytes, but only one exact-head authority CAS wins.
  const raceAuthority = new Authority();
  const raceHead = raceAuthority.head;
  const raceA = validatePublishAndSettle(
    ordinaryCandidate,
    claim,
    store,
    raceAuthority,
    raceHead,
  );
  assert.ok(raceA);
  const raceB = validatePublishAndSettle(
    alternateCandidate,
    claim,
    store,
    raceAuthority,
    raceHead,
  );
  assert.equal(raceB, null);
  assert.equal(raceAuthority.settlements.size, 1);
  assert.equal(consume(raceA, store).downstream_identity, consume(raceA, store).downstream_identity);

  // Corruption at an authoritative evidence coordinate makes downstream consumption fail closed.
  const corruptRoot = join(root, 'corrupt-evidence');
  const corruptStore = new FileEvidenceStore(corruptRoot);
  const corruptAuthority = new Authority();
  const corruptSettlement = validatePublishAndSettle(
    ordinaryCandidate,
    claim,
    corruptStore,
    corruptAuthority,
    corruptAuthority.head,
  );
  assert.ok(corruptSettlement);
  writeFileSync(corruptStore.pathFor(corruptSettlement.receipt.artifact), Buffer.from('corrupt'));
  assert.throws(() => consume(corruptSettlement, corruptStore), /EVIDENCE_/);

  // Negative control: trusting a worker-declared identity aliases distinct bytes.
  const unsafeDeclaredDigest = 'worker-says-same';
  const unsafeIdentityA = canonicalDigest({
    downstream: 'source-integration',
    worker_declared_output: unsafeDeclaredDigest,
  });
  const unsafeIdentityB = canonicalDigest({
    downstream: 'source-integration',
    worker_declared_output: unsafeDeclaredDigest,
  });
  assert.equal(unsafeIdentityA, unsafeIdentityB);
  assert.notDeepEqual(
    Buffer.from(ordinaryCandidate.artifact_base64, 'base64'),
    Buffer.from(alternateCandidate.artifact_base64, 'base64'),
  );

  // Negative control: authority-first publication can create a dangling reference.
  const danglingAuthority = new Authority();
  const neverPublished = evidenceRef(Buffer.from('never published'));
  const dangling = danglingAuthority.append(danglingAuthority.head, {
    schema: 'experiment-verified-generated-output/v1',
    run_id: claim.run_id,
    claimed_revision: claim.claimed_revision,
    source_revision: claim.source_revision,
    verifier: 'source-proposal-scope/v1',
    artifact: neverPublished,
    changed_paths: ['src/feature.ts'],
  });
  assert.ok(dangling);
  const emptyStore = new FileEvidenceStore(join(root, 'empty-evidence'));
  assert.throws(() => consume(dangling, emptyStore), /EVIDENCE_NOT_FOUND/);

  console.log(
    JSON.stringify(
      {
        experiment: 'verified-generated-output',
        ordinary: {
          settlement: ordinary.commit,
          evidence_digest: ordinary.receipt.artifact.digest,
          downstream_identity: ordinaryConsumed.downstream_identity,
        },
        output_sensitivity: {
          different_evidence: ordinary.receipt.artifact.digest !== alternate.receipt.artifact.digest,
          different_settlement: ordinary.commit !== alternate.commit,
          different_downstream_identity:
            ordinaryConsumed.downstream_identity !== consume(alternate, store).downstream_identity,
        },
        hostile_binding_cases: 4,
        scope_violation_rejected: true,
        orphan_publication_authority_unchanged: true,
        writer_race_single_authority_winner: true,
        corrupt_referenced_evidence_fails_closed: true,
        worker_declared_identity_negative_control_killed: true,
        authority_first_negative_control_killed: true,
        conclusion: 'supported-within-bounds',
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
