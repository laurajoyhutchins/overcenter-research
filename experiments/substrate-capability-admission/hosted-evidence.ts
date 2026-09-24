#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  admissionMatrix,
  issueEvidence,
  type AdmissionContext,
  EVIDENCE_SCHEMA,
  type EvidencePayload,
  type FixtureFile,
  type SignedEvidence,
  type TrustRoots,
} from './admission.ts';

const controlledProof = process.env.CONTROLLED_PROOF;
const deniedHttp = process.env.STATUS_WRITE_DENIED_HTTP;
const ambientHttp = process.env.STATUS_WRITE_AMBIENT_HTTP;
const revision = process.env.SOURCE_SHA;
const executionId = process.env.EXECUTION_ID;
const epoch = process.env.EVIDENCE_EPOCH;

assert.equal(controlledProof, 'passed');
assert.equal(deniedHttp, '403');
assert.equal(ambientHttp, '201');
assert(revision && executionId && epoch);

const fixtureFile = JSON.parse(
  readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'),
) as FixtureFile;

const controlledKeys = generateKeyPairSync('ed25519');
const probeKeys = generateKeyPairSync('ed25519');
const trustRoots: TrustRoots = {
  controlledSubstrateAttestor: controlledKeys.publicKey,
  trustedCapabilityProbe: probeKeys.publicKey,
};
const context: AdmissionContext = { revision, executionId, epoch };

function payload(
  substrateId: string,
  guarantee: EvidencePayload['guarantee'],
  issuer: EvidencePayload['issuer'],
): EvidencePayload {
  return {
    schema: EVIDENCE_SCHEMA,
    issuer,
    substrateId,
    capability: 'github.commit-status.write',
    guarantee,
    revision,
    executionId,
    epoch,
  };
}

const evidenceByFixture = new Map<string, SignedEvidence>([
  [
    'controlled-sandbox',
    issueEvidence(
      payload('controlled-sandbox', 'controlled-isolation', 'controlled-substrate-attestor'),
      controlledKeys.privateKey,
    ),
  ],
  [
    'foreign-status-write-denied',
    issueEvidence(
      payload('foreign-status-write-denied', 'observed-absent', 'trusted-capability-probe'),
      probeKeys.privateKey,
    ),
  ],
  [
    'foreign-ambient-status-write',
    issueEvidence(
      payload('foreign-ambient-status-write', 'present', 'trusted-capability-probe'),
      probeKeys.privateKey,
    ),
  ],
  [
    'hostile-liar',
    issueEvidence(
      payload('hostile-liar', 'present', 'trusted-capability-probe'),
      probeKeys.privateKey,
    ),
  ],
]);

const matrix = admissionMatrix(
  fixtureFile.fixtures,
  evidenceByFixture,
  fixtureFile.obligations,
  context,
  trustRoots,
);
assert.deepEqual(matrix, fixtureFile.expected);

console.log(
  JSON.stringify(
    {
      schema: 'overcenter-substrate-capability-hosted-evidence/v2',
      revision,
      executionId,
      epoch,
      controlledProof,
      statusWriteDeniedHttp: deniedHttp,
      statusWriteAmbientHttp: ambientHttp,
      capability: 'github.commit-status.write',
      matrix,
    },
    null,
    2,
  ),
);
