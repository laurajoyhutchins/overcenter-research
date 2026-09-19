import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CLAIM_SCHEMA,
  EFFECT_RESERVATION_SCHEMA,
  EXECUTION_AUTHORITY_SCHEMA,
  LEGACY_RECEIPT_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
  validateAuthorityFact,
} from '../src/facts.ts';

import {
  validateAbsenceEvidenceEnvelope,
} from '../src/evidence.ts';
import {
  validateObservationEnvelope,
} from '../src/observation.ts';
import {
  validateProviderObservationEnvelope,
} from '../src/provider-observation/observation.ts';

import {
  COMPUTATION_EVIDENCE_SCHEMA,
  COMPUTATION_EXECUTION_SCHEMA,
  EXECUTOR_COMMAND_SCHEMA,
  EXECUTOR_HELLO_SCHEMA,
  PROCESS_SPEC_SCHEMA,
  validateExecutorHello,
  validateProcessSpec,
} from '../src/computation-execution.ts';

import { GoExecutorClient } from '../src/go-executor-client.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const contractDir=join(root,'contracts/computation-execution-v1');
const authorityContractDir=join(root,'contracts/authority-facts-v1');
const observationContractDir=join(root,'contracts/observation-evidence-v1');
const readJson=(path:string):any=>JSON.parse(readFileSync(path,'utf8'));

const contract=readJson(join(contractDir,'contract.json'));
const schema=readJson(join(contractDir,'schema.json'));
const conformance=readJson(join(contractDir,'process-spec-conformance.json'));
const authorityContract=readJson(join(authorityContractDir,'contract.json'));
const authoritySchema=readJson(join(authorityContractDir,'schema.json'));
const authorityConformance=readJson(
  join(authorityContractDir,'authority-fact-conformance.json'),
);
const observationContract=readJson(
  join(observationContractDir,'contract.json'),
);
const observationSchema=readJson(
  join(observationContractDir,'schema.json'),
);
const observationConformance=readJson(
  join(observationContractDir,'observation-evidence-conformance.json'),
);
const goProtocol=readFileSync(join(root,'executor/protocol.go'),'utf8');
const goMain=readFileSync(join(root,'executor/cmd/overcenter-executor/main.go'),'utf8');

test('computation contract declares explicit structural authority and compatibility',()=>{
  assert.equal(contract.apiVersion,'overcenter.dev/data-contract/v1');
  assert.equal(contract.kind,'DataContract');
  assert.equal(contract.id,'computation-execution');
  assert.equal(contract.version,'1.0.0');
  assert.equal(contract.status,'active');
  assert.equal(contract.governance.structureAuthority,'./schema.json');
  assert.equal(contract.governance.conflictPolicy,'machine-readable-structure-wins');
  assert.equal(contract.compatibility.unknownFields,'reject');
  assert.equal(schema.$schema,'https://json-schema.org/draft/2020-12/schema');

  assert.deepEqual(contract.schema.wireDiscriminators,[
    PROCESS_SPEC_SCHEMA,
    COMPUTATION_EXECUTION_SCHEMA,
    EXECUTOR_COMMAND_SCHEMA,
    COMPUTATION_EVIDENCE_SCHEMA,
    EXECUTOR_HELLO_SCHEMA,
  ]);
});

test('wire discriminator registry agrees with TypeScript, Go, and JSON Schema',()=>{
  const defs=schema.$defs;
  assert.equal(defs.ProcessSpecV1.properties.schema.const,PROCESS_SPEC_SCHEMA);
  assert.equal(defs.ComputationExecutionV1.properties.schema.const,COMPUTATION_EXECUTION_SCHEMA);
  assert.equal(defs.ExecuteCommandV1.properties.schema.const,EXECUTOR_COMMAND_SCHEMA);
  assert.equal(defs.CancelCommandV1.properties.schema.const,EXECUTOR_COMMAND_SCHEMA);
  assert.equal(defs.ComputationAttemptEvidenceV1.properties.schema.const,COMPUTATION_EVIDENCE_SCHEMA);
  assert.equal(defs.ExecutorHelloV1.properties.schema.const,EXECUTOR_HELLO_SCHEMA);

  for (const [goName,value] of [
    ['ProcessSpecSchema',PROCESS_SPEC_SCHEMA],
    ['ComputationExecutionSchema',COMPUTATION_EXECUTION_SCHEMA],
    ['ExecutorCommandSchema',EXECUTOR_COMMAND_SCHEMA],
    ['ComputationEvidenceSchema',COMPUTATION_EVIDENCE_SCHEMA],
  ] as const) {
    assert.match(goProtocol,new RegExp(goName+'\\s*=\\s*"'+value+'"'));
  }
  assert.match(
    goMain,
    new RegExp('executorHelloSchema\\s*=\\s*"'+EXECUTOR_HELLO_SCHEMA+'"'),
  );
});

function collectOvercenterKeywords(value:unknown,found=new Set<string>()):Set<string> {
  if (!value || typeof value!=='object') return found;
  if (Array.isArray(value)) {
    for (const member of value) collectOvercenterKeywords(member,found);
    return found;
  }
  for (const [key,member] of Object.entries(value as Record<string,unknown>)) {
    if (key.startsWith('x-overcenter-')) found.add(key);
    collectOvercenterKeywords(member,found);
  }
  return found;
}

test('all non-standard validation semantics are declared by the contract',()=>{
  assert.deepEqual(
    [...collectOvercenterKeywords(schema)].sort(),
    [...contract.schema.validationExtensions].sort(),
  );
});

test('the checked-in process-spec corpus is executable against the production validator',()=>{
  assert.equal(conformance.schema,'overcenter-process-spec-conformance-v1');
  for (const candidate of conformance.cases as Array<{name:string;valid:boolean;spec:unknown}>) {
    if (candidate.valid) {
      assert.doesNotThrow(
        ()=>validateProcessSpec(candidate.spec),
        candidate.name,
      );
    } else {
      assert.throws(
        ()=>validateProcessSpec(candidate.spec),
        undefined,
        candidate.name,
      );
    }
  }
});

test('semantic identity is explicit, complete, and separate from diagnostic evidence',()=>{
  const execution=contract.semanticIdentity.computationExecution;
  const evidence=contract.semanticIdentity.attemptEvidence;
  const executionRequired=new Set(schema.$defs.ComputationExecutionV1.required);
  const evidenceRequired=new Set(schema.$defs.ComputationAttemptEvidenceV1.required);

  for (const field of execution.materialFields as string[]) {
    assert.equal(executionRequired.has(field),true,'execution identity field '+field);
  }
  assert.deepEqual(evidence.identityBindingFields,execution.materialFields);
  for (const field of evidence.identityBindingFields as string[]) {
    assert.equal(evidenceRequired.has(field),true,'evidence identity field '+field);
  }

  const identity=new Set(evidence.identityBindingFields as string[]);
  const result=new Set(evidence.resultFields as string[]);
  const diagnostic=new Set(evidence.diagnosticFields as string[]);
  for (const field of [...result,...diagnostic]) {
    assert.equal(identity.has(field),false,'non-identity field leaked into identity: '+field);
  }
  for (const field of diagnostic) {
    assert.equal(result.has(field),false,'diagnostic field leaked into attempt result: '+field);
  }

  const classified=new Set([...identity,...result,...diagnostic]);
  const payloadFields=Object.keys(
    schema.$defs.ComputationAttemptEvidenceV1.properties,
  ).filter(field=>field!=='schema');
  assert.deepEqual([...classified].sort(),payloadFields.sort());
  assert.equal(evidence.settlementAuthority,false);
});

test('executor hello uses the shared UTF-8 byte limit across the language boundary',()=>{
  const base={
    schema:EXECUTOR_HELLO_SCHEMA,
    execution_context_sha256:'sha256:'+'0'.repeat(64),
  };
  assert.doesNotThrow(()=>validateExecutorHello({
    ...base,
    containment_id:'é'.repeat(256),
  }));
  assert.throws(
    ()=>validateExecutorHello({
      ...base,
      containment_id:'é'.repeat(257),
    }),
    /CONTAINMENT_ID_INVALID/,
  );
  assert.throws(
    ()=>validateExecutorHello({
      ...base,
      containment_id:'valid',
      extra:true,
    }),
    /EXECUTOR_HELLO_UNKNOWN_FIELD:extra/,
  );
  assert.throws(
    ()=>new GoExecutorClient({
      socketPath:'/tmp/overcenter-contract-invalid.sock',
      maxConcurrency:1,
      executionContextSha256:base.execution_context_sha256,
      containmentId:'é'.repeat(257),
    }),
    /GO_EXECUTOR_CONTAINMENT_ID_INVALID/,
  );
});


test('durable authority contract preserves backend-neutral logical facts',()=>{
  assert.equal(authorityContract.id,'authority-facts');
  assert.equal(authorityContract.version,'1.0.0');
  assert.equal(authorityContract.status,'active');
  assert.equal(authorityContract.storageIndependence.backendLocalCommitIdentity,true);
  assert.deepEqual(authorityContract.schema.wireDiscriminators,[
    OBLIGATION_SCHEMA,
    CLAIM_SCHEMA,
    EXECUTION_AUTHORITY_SCHEMA,
    EFFECT_RESERVATION_SCHEMA,
    LEGACY_RECEIPT_SCHEMA,
    RECEIPT_SCHEMA,
  ]);
  assert.deepEqual(authorityContract.compatibility.receipt.read,[
    LEGACY_RECEIPT_SCHEMA,
    RECEIPT_SCHEMA,
  ]);
  assert.equal(authorityContract.compatibility.receipt.write,RECEIPT_SCHEMA);

  assert.equal(
    authoritySchema.$defs.DefinedObligationFact.properties.schema.const,
    OBLIGATION_SCHEMA,
  );
  assert.equal(
    authoritySchema.$defs.AmendedObligationFact.properties.schema.const,
    OBLIGATION_SCHEMA,
  );
  assert.equal(
    authoritySchema.$defs.ClaimFact.properties.schema.const,
    CLAIM_SCHEMA,
  );
  assert.equal(
    authoritySchema.$defs.ExecutionAuthorityFact.properties.schema.const,
    EXECUTION_AUTHORITY_SCHEMA,
  );
  assert.equal(
    authoritySchema.$defs.EffectReservationFact.properties.schema.const,
    EFFECT_RESERVATION_SCHEMA,
  );
  assert.equal(
    authoritySchema.$defs.ReceiptFactV4.properties.schema.const,
    LEGACY_RECEIPT_SCHEMA,
  );
  assert.equal(
    authoritySchema.$defs.ReceiptFactV5.properties.schema.const,
    RECEIPT_SCHEMA,
  );
});

test('authority fact conformance corpus runs against the production envelope validators',()=>{
  assert.equal(
    authorityConformance.schema,
    'overcenter-authority-fact-conformance-v1',
  );
  for (const candidate of authorityConformance.cases as Array<{
    name:string;
    valid:boolean;
    fact:unknown;
  }>) {
    if (candidate.valid) {
      assert.doesNotThrow(
        ()=>validateAuthorityFact(candidate.fact),
        candidate.name,
      );
    } else {
      assert.throws(
        ()=>validateAuthorityFact(candidate.fact),
        undefined,
        candidate.name,
      );
    }
  }
});

test('authority receipt contract excludes derived settlement truth from persisted facts',()=>{
  const receipt=authorityContract.semanticRoles.receiptFact;
  const persisted=new Set(
    Object.keys(authoritySchema.$defs.ReceiptFactV5.properties),
  );
  for (const field of receipt.derivedFieldsExcluded as string[]) {
    assert.equal(
      persisted.has(field),
      false,
      'derived settlement field became writable: '+field,
    );
  }

  const roles=[
    ...receipt.authorityBindingFields,
    ...receipt.resultFields,
    ...receipt.auditFields,
    ...receipt.diagnosticFields,
  ] as string[];
  assert.deepEqual(
    [...new Set(roles)].sort(),
    [...persisted].filter(field=>field!=='schema').sort(),
  );
});

test('every intentionally open authority payload is named in contract metadata',()=>{
  const declared=new Set(
    authorityContract.openBoundaries.map((entry:{path:string})=>entry.path),
  );
  assert.deepEqual(declared,new Set([
    'Obligation.packet',
    'Obligation.postcondition',
    'ReceiptFact.observed',
    'ReceiptFact.diagnostic',
  ]));

  const openKeyword='x-overcenter-openBoundary';
  const schemaText=JSON.stringify(authoritySchema);
  assert.match(schemaText,new RegExp(openKeyword));
  assert.ok(authorityContract.schema.validationExtensions.includes(openKeyword));
});


test('provider observation schema fences provider-specific outer extensions',()=>{
  const providerDefs=observationSchema.$defs;
  assert.equal(
    providerDefs.KubernetesProviderContract.properties.provider.const,
    'kubernetes',
  );
  const genericProviderConstraint=
    providerDefs.GenericProviderObservation.properties.contract.allOf[1]
      .properties.provider.not.const;
  assert.equal(genericProviderConstraint,'kubernetes');
  assert.equal(
    providerDefs.KubernetesProviderObservation.required.includes('authority_id'),
    true,
  );
});

test('observation contract separates envelope validity from negative-evidence authority',()=>{
  assert.equal(observationContract.id,'observation-evidence');
  assert.equal(observationContract.version,'1.0.0');
  assert.equal(observationContract.status,'active');
  assert.equal(
    observationSchema.$defs.AbsenceEvidenceEnvelope.properties.schema.const,
    'overcenter-absence-evidence-v1',
  );
  assert.deepEqual(
    observationContract.knownAbsenceEvidenceKinds.map(
      (entry:{kind:string})=>entry.kind,
    ),
    ['local-file-enoent/v1','kubernetes-complete-list-absence/v1'],
  );
});

test('observation/evidence conformance corpus runs against production envelope validators',()=>{
  assert.equal(
    observationConformance.schema,
    'overcenter-observation-evidence-conformance-v1',
  );
  for (const candidate of observationConformance.cases as Array<{
    name:string;
    kind:string;
    valid:boolean;
    value:unknown;
  }>) {
    const validate=()=>{
      if (candidate.kind==='provider-observation') {
        validateProviderObservationEnvelope(candidate.value);
        return;
      }
      if (candidate.kind==='kubernetes-provider-observation') {
        validateProviderObservationEnvelope(
          candidate.value,
          {topLevelExtensions:['authority_id']},
        );
        return;
      }
      if (candidate.kind==='settlement-observation') {
        validateObservationEnvelope(candidate.value);
        return;
      }
      if (candidate.kind==='absence-envelope') {
        validateAbsenceEvidenceEnvelope(candidate.value);
        return;
      }
      throw new Error('UNKNOWN_OBSERVATION_CONFORMANCE_KIND');
    };
    if (candidate.valid) assert.doesNotThrow(validate,candidate.name);
    else assert.throws(validate,undefined,candidate.name);
  }
});
