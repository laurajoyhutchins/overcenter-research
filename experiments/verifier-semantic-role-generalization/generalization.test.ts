import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AbsenceEvidenceCertificate,
  Observation,
  Postcondition,
} from '../../src/model.ts';
import { canonicalDigest, sha256 } from '../../src/digest.ts';
import {
  ABSENCE_EVIDENCE_SCHEMA,
  localFileEnoentEvidence,
} from '../../src/evidence.ts';
import {
  authoritativeAbsenceEvidence,
  observationVerified,
} from '../../src/observation.ts';
import {
  effectSemantics,
  settlementSemantics,
  verifiedContentIdentity,
} from '../../src/semantics.ts';
import {
  KUBERNETES_COMPLETE_LIST_ABSENCE,
  KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  kubernetesConfigMapAbsenceEvidenceMatches,
} from '../../src/providers/kubernetes-configmap.ts';
import {
  descriptorAbsenceBinding,
  descriptorEffectSemantics,
  descriptorObservationMatches,
  descriptorSettlementSemantics,
  descriptorVerifiedContentIdentity,
  verifierSemanticDescriptors,
} from './descriptor.ts';

const SHA='a'.repeat(40);

const file:Postcondition={
  verifier:'file-content-equals/v1',
  path:'/tmp/semantic-role-proof',
  content:'expected-content',
};
const eventual:Postcondition={
  verifier:'eventually-consistent-file-content-equals/v1',
  path:'/tmp/eventual-semantic-role-proof',
  content:'eventual-content',
};
const githubV1:Postcondition={
  verifier:'github-commit-status/v1',
  provider:'github',
  repository_id:123,
  commit_sha:SHA,
  context:'Overcenter/CI',
  expected_state:'success',
};
const githubV2:Postcondition={
  verifier:'github-commit-status/v2',
  provider:'github',
  repository_id:123,
  repository_full_name:'Owner/Repo',
  commit_sha:SHA,
  context:'Overcenter/CI',
  expected_state:'success',
};
const kubernetes:Postcondition={
  verifier:'kubernetes-configmap-exists/v1',
  provider:'kubernetes',
  authority_id:'kind:cluster-a',
  api_group:'',
  resource:'configmaps',
  namespace:'proof',
  name:'target',
};

const all=[file,eventual,githubV1,githubV2,kubernetes] as const;

function matchingObservation(postcondition:Postcondition):Observation {
  if (
    postcondition.verifier==='file-content-equals/v1'
    || postcondition.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    return {
      verifier:postcondition.verifier,
      path:postcondition.path,
      actual_sha256:sha256(postcondition.content),
      mutation_certainty:'present',
    };
  }
  if (
    postcondition.verifier==='github-commit-status/v1'
    || postcondition.verifier==='github-commit-status/v2'
  ) {
    return {
      verifier:postcondition.verifier,
      provider:'github',
      repository_id:postcondition.repository_id,
      ...(postcondition.verifier==='github-commit-status/v2'
        ? {repository_full_name:postcondition.repository_full_name}
        : {}),
      commit_sha:postcondition.commit_sha,
      context:postcondition.context,
      expected_state:postcondition.expected_state,
      actual_state:postcondition.expected_state,
      mutation_certainty:'present',
    };
  }
  return {
    verifier:postcondition.verifier,
    provider:'kubernetes',
    authority_id:postcondition.authority_id,
    api_group:postcondition.api_group,
    resource:postcondition.resource,
    namespace:postcondition.namespace,
    name:postcondition.name,
    observed_uid:'uid-target',
    observed_resource_version:'500',
    mutation_certainty:'present',
  };
}

function containsFunction(value:unknown):boolean {
  if (typeof value==='function') return true;
  if (Array.isArray(value)) return value.some(containsFunction);
  if (value && typeof value==='object') {
    return Object.values(value as Record<string,unknown>).some(containsFunction);
  }
  return false;
}

function expectCoordinateMismatch(
  postcondition:Postcondition,
  observed:Observation,
):void {
  assert.equal(descriptorObservationMatches(postcondition,observed),false);
  assert.throws(
    ()=>observationVerified(postcondition,observed),
    /OBSERVATION_COORDINATE_MISMATCH/,
  );
}

test('data-only descriptors cover every current verifier in the differential corpus',()=>{
  assert.deepEqual(
    Object.keys(verifierSemanticDescriptors).sort(),
    all.map(item=>item.verifier).sort(),
  );
  assert.equal(containsFunction(verifierSemanticDescriptors),false);
});

test('descriptor-derived output, effect, and settlement semantics match production for every verifier',()=>{
  for (const postcondition of all) {
    assert.equal(
      descriptorVerifiedContentIdentity(postcondition),
      verifiedContentIdentity(postcondition),
      postcondition.verifier,
    );
    assert.deepEqual(
      descriptorEffectSemantics(postcondition),
      effectSemantics(postcondition),
      postcondition.verifier,
    );
    assert.deepEqual(
      descriptorSettlementSemantics(postcondition),
      settlementSemantics(postcondition),
      postcondition.verifier,
    );
  }
});

test('descriptor-derived observation binding matches production for every verifier',()=>{
  for (const postcondition of all) {
    const observed=matchingObservation(postcondition);
    assert.equal(descriptorObservationMatches(postcondition,observed),true);
    assert.equal(observationVerified(postcondition,observed),true);
  }
});

test('GitHub context has different observation and semantic canonicalization on purpose',()=>{
  const lower={...githubV1,context:'overcenter/ci'} as Postcondition;
  assert.equal(
    descriptorVerifiedContentIdentity(githubV1),
    descriptorVerifiedContentIdentity(lower),
  );
  assert.deepEqual(
    descriptorEffectSemantics(githubV1),
    descriptorEffectSemantics(lower),
  );
  assert.equal(
    verifiedContentIdentity(githubV1),
    verifiedContentIdentity(lower),
  );
  assert.deepEqual(effectSemantics(githubV1),effectSemantics(lower));

  const observed=matchingObservation(githubV1);
  expectCoordinateMismatch(lower,observed);
});

test('GitHub v2 repository full name is an observation alias, not semantic resource identity',()=>{
  const caseOnly={...githubV2,repository_full_name:'owner/repo'} as Postcondition;
  const renamed={...githubV2,repository_full_name:'Other/Repo'} as Postcondition;
  const observed=matchingObservation(githubV2);

  assert.equal(descriptorObservationMatches(caseOnly,observed),true);
  assert.equal(observationVerified(caseOnly,observed),true);
  expectCoordinateMismatch(renamed,observed);

  assert.equal(
    descriptorVerifiedContentIdentity(githubV2),
    descriptorVerifiedContentIdentity(renamed),
  );
  assert.deepEqual(
    descriptorEffectSemantics(githubV2),
    descriptorEffectSemantics(renamed),
  );
  assert.equal(
    verifiedContentIdentity(githubV2),
    verifiedContentIdentity(renamed),
  );
  assert.deepEqual(effectSemantics(githubV2),effectSemantics(renamed));
});

test('file and Kubernetes coordinate mutations fail exactly where production fails',()=>{
  expectCoordinateMismatch(
    file,
    {...matchingObservation(file),path:'/tmp/other'},
  );
  expectCoordinateMismatch(
    kubernetes,
    {...matchingObservation(kubernetes),authority_id:'kind:cluster-b'},
  );
  expectCoordinateMismatch(
    kubernetes,
    {...matchingObservation(kubernetes),namespace:'other'},
  );
  expectCoordinateMismatch(
    kubernetes,
    {...matchingObservation(kubernetes),name:'other'},
  );
});

test('local-file absence subject and scope are derived from the same path role',()=>{
  const binding=descriptorAbsenceBinding(file);
  assert.ok(binding);
  const evidence=localFileEnoentEvidence(file.path);
  assert.equal(binding.kind,evidence.kind);
  assert.deepEqual(binding.subject,evidence.subject);
  assert.deepEqual(binding.scope,evidence.scope);

  const observed:Observation={
    verifier:file.verifier,
    path:file.path,
    mutation_certainty:'absent',
    absence_evidence:evidence,
  };
  assert.deepEqual(authoritativeAbsenceEvidence(file,observed),evidence);
});

function kubernetesAbsenceCertificate(
  postcondition:Extract<Postcondition,{verifier:'kubernetes-configmap-exists/v1'}>,
):AbsenceEvidenceCertificate {
  const binding=descriptorAbsenceBinding(postcondition);
  assert.ok(binding);
  const pages=[{
    page:1,
    request_continue:null,
    response_continue:'',
    snapshot_resource_version:'500',
  }];
  return {
    schema:ABSENCE_EVIDENCE_SCHEMA,
    kind:KUBERNETES_COMPLETE_LIST_ABSENCE,
    subject:binding.subject,
    scope:binding.scope,
    snapshot:{resource_version:'500'},
    completeness:{
      kind:'complete-list',
      page_count:1,
      terminal_continue:'',
      page_chain_digest:`sha256:${canonicalDigest(pages)}`,
    },
    provenance:{
      provider:'kubernetes',
      authority_id:postcondition.authority_id,
      operation_id:KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
      pages,
    },
  };
}

test('Kubernetes roles derive subject versus collection scope without flattening target identity',()=>{
  const pc=kubernetes as Extract<Postcondition,{verifier:'kubernetes-configmap-exists/v1'}>;
  const otherName={...pc,name:'other'};
  const otherNamespace={...pc,namespace:'other'};
  const original=descriptorAbsenceBinding(pc);
  const renamed=descriptorAbsenceBinding(otherName);
  const moved=descriptorAbsenceBinding(otherNamespace);
  assert.ok(original);
  assert.ok(renamed);
  assert.ok(moved);

  assert.notDeepEqual(original.subject,renamed.subject);
  assert.deepEqual(original.scope,renamed.scope);
  assert.notDeepEqual(original.subject,moved.subject);
  assert.notDeepEqual(original.scope,moved.scope);

  const certificate=kubernetesAbsenceCertificate(pc);
  assert.equal(kubernetesConfigMapAbsenceEvidenceMatches(certificate,pc),true);
  assert.equal(kubernetesConfigMapAbsenceEvidenceMatches(certificate,otherName),false);
  assert.equal(kubernetesConfigMapAbsenceEvidenceMatches(certificate,otherNamespace),false);

  const observed:Observation={
    ...matchingObservation(pc),
    mutation_certainty:'absent',
    absence_evidence:certificate,
  };
  assert.deepEqual(authoritativeAbsenceEvidence(pc,observed),certificate);
});

test('provider proof completeness stays outside the semantic-role descriptor',()=>{
  const pc=kubernetes as Extract<Postcondition,{verifier:'kubernetes-configmap-exists/v1'}>;
  const binding=descriptorAbsenceBinding(pc);
  const certificate=kubernetesAbsenceCertificate(pc);
  const forged=structuredClone(certificate);
  forged.completeness.page_chain_digest=`sha256:${'0'.repeat(64)}`;

  assert.deepEqual(descriptorAbsenceBinding(pc),binding);
  assert.equal(kubernetesConfigMapAbsenceEvidenceMatches(forged,pc),false);
  assert.equal(
    authoritativeAbsenceEvidence(pc,{
      ...matchingObservation(pc),
      mutation_certainty:'absent',
      absence_evidence:forged,
    }),
    null,
  );
});
