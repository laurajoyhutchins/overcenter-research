#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  admit,
  admissionMatrix,
  issueEvidence,
  naiveDescriptorAdmission,
  type AdmissionContext,
  EVIDENCE_SCHEMA,
  type EvidencePayload,
  type FixtureFile,
  type SignedEvidence,
  type TrustRoots,
} from './admission.ts';

const fixtureFile = JSON.parse(
  readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'),
) as FixtureFile;
assert.equal(fixtureFile.schema, 'overcenter-substrate-capability-fixtures/v1');

const controlledKeys = generateKeyPairSync('ed25519');
const probeKeys = generateKeyPairSync('ed25519');
const attackerKeys = generateKeyPairSync('ed25519');
const trustRoots: TrustRoots = {
  controlledSubstrateAttestor: controlledKeys.publicKey,
  trustedCapabilityProbe: probeKeys.publicKey,
};
const context: AdmissionContext = {
  revision: 'revision-a',
  executionId: 'execution-a',
  epoch: 'epoch-a',
};

const byId = new Map(fixtureFile.fixtures.map((fixture) => [fixture.id, fixture]));
const controlled = byId.get('controlled-sandbox');
const denied = byId.get('foreign-status-write-denied');
const ambient = byId.get('foreign-ambient-status-write');
const liar = byId.get('hostile-liar');
assert(controlled && denied && ambient && liar);

function payload(
  substrateId: string,
  guarantee: EvidencePayload['guarantee'],
  issuer: EvidencePayload['issuer'],
  capability: EvidencePayload['capability'] = 'github.commit-status.write',
  overrides: Partial<AdmissionContext> = {},
): EvidencePayload {
  return {
    schema: EVIDENCE_SCHEMA,
    issuer,
    substrateId,
    capability,
    guarantee,
    revision: overrides.revision ?? context.revision,
    executionId: overrides.executionId ?? context.executionId,
    epoch: overrides.epoch ?? context.epoch,
  };
}

const evidence = new Map<string, SignedEvidence>([
  [
    controlled.id,
    issueEvidence(
      payload(controlled.id, 'controlled-isolation', 'controlled-substrate-attestor'),
      controlledKeys.privateKey,
    ),
  ],
  [
    denied.id,
    issueEvidence(
      payload(denied.id, 'observed-absent', 'trusted-capability-probe'),
      probeKeys.privateKey,
    ),
  ],
  [
    ambient.id,
    issueEvidence(payload(ambient.id, 'present', 'trusted-capability-probe'), probeKeys.privateKey),
  ],
  [
    liar.id,
    issueEvidence(payload(liar.id, 'present', 'trusted-capability-probe'), probeKeys.privateKey),
  ],
]);

const actual = admissionMatrix(
  fixtureFile.fixtures,
  evidence,
  fixtureFile.obligations,
  context,
  trustRoots,
);
assert.deepEqual(actual, fixtureFile.expected);

const strict = fixtureFile.obligations.find(
  (obligation) => obligation.id === 'requires-controlled-status-write-isolation',
);
const absent = fixtureFile.obligations.find(
  (obligation) => obligation.id === 'requires-status-write-absent-through-execution',
);
assert(strict && absent);

assert.equal(
  admit(denied, evidence.get(denied.id)!, absent, context, trustRoots).accepted,
  false,
  'point observation of absence must not authorize an absence requirement on a mutable foreign substrate',
);

const wrongSchemaPayload = {
  ...payload(denied.id, 'observed-absent', 'trusted-capability-probe'),
  schema: 'overcenter-substrate-capability-evidence/other',
} as unknown as EvidencePayload;
const wrongSchema = issueEvidence(wrongSchemaPayload, probeKeys.privateKey);
assert.equal(
  admit(denied, wrongSchema, absent, context, trustRoots).accepted,
  false,
  'a signed envelope with an unrecognized schema must fail runtime verification',
);

const probeClaimsControlled = issueEvidence(
  payload(denied.id, 'controlled-isolation', 'trusted-capability-probe'),
  probeKeys.privateKey,
);
assert.equal(
  admit(denied, probeClaimsControlled, strict, context, trustRoots).accepted,
  false,
  'the capability probe cannot assert controlled isolation',
);

const controllerClaimsObservedAbsence = issueEvidence(
  payload(controlled.id, 'observed-absent', 'controlled-substrate-attestor'),
  controlledKeys.privateKey,
);
assert.equal(
  admit(controlled, controllerClaimsObservedAbsence, absent, context, trustRoots).accepted,
  false,
  'the controlled-substrate attestor cannot assert observational absence',
);

assert.equal(
  naiveDescriptorAdmission(liar, strict),
  true,
  'descriptor-only negative control must admit the lying descriptor',
);
assert.equal(admit(liar, evidence.get(liar.id)!, strict, context, trustRoots).accepted, false);

const forged = {
  ...evidence.get(liar.id)!,
  guarantee: 'controlled-isolation' as const,
};
assert.equal(
  admit(liar, forged, strict, context, trustRoots).accepted,
  false,
  'changing a signed guarantee without the attestor key must fail',
);

const attackerSigned = issueEvidence(
  payload(liar.id, 'controlled-isolation', 'controlled-substrate-attestor'),
  attackerKeys.privateKey,
);
assert.equal(
  admit(liar, attackerSigned, strict, context, trustRoots).accepted,
  false,
  'an attacker cannot self-assert the trusted issuer name',
);

assert.equal(
  admit(ambient, evidence.get(denied.id)!, absent, context, trustRoots).accepted,
  false,
  'valid evidence for another substrate must fail',
);

const wrongCapability = issueEvidence(
  payload(denied.id, 'observed-absent', 'trusted-capability-probe', 'github.contents.write'),
  probeKeys.privateKey,
);
assert.equal(
  admit(denied, wrongCapability, absent, context, trustRoots).accepted,
  false,
  'valid evidence for another capability must fail',
);

const stale = issueEvidence(
  payload(denied.id, 'observed-absent', 'trusted-capability-probe', 'github.commit-status.write', {
    epoch: 'epoch-before-credential-change',
  }),
  probeKeys.privateKey,
);
assert.equal(
  admit(denied, stale, absent, context, trustRoots).accepted,
  false,
  'evidence bound to an older epoch must fail once the admission context epoch changes',
);

const wrongRevision = issueEvidence(
  payload(denied.id, 'observed-absent', 'trusted-capability-probe', 'github.commit-status.write', {
    revision: 'revision-before-rebase',
  }),
  probeKeys.privateKey,
);
assert.equal(
  admit(denied, wrongRevision, absent, context, trustRoots).accepted,
  false,
  'evidence from another revision must fail',
);

console.log(
  JSON.stringify(
    {
      schema: 'overcenter-substrate-capability-admission-result/v2',
      result: 'DETERMINISTIC_BOUNDARY_SUPPORTED',
      matrix: actual,
      negativeControls: {
        descriptorLiarWouldPassNaiveAdmission: true,
        descriptorLiarRejectedByTrustedEvidence: true,
        forgedGuaranteeRejected: true,
        forgedIssuerRejected: true,
        wrongSubstrateRejected: true,
        wrongCapabilityRejected: true,
        staleEpochRejected: true,
        wrongRevisionRejected: true,
        wrongSchemaRejected: true,
        observedAbsenceIsNonAuthorizing: true,
        probeCannotAssertControlledIsolation: true,
        controllerCannotAssertObservedAbsence: true,
      },
    },
    null,
    2,
  ),
);
