import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalDigest, sha256 } from '../src/digest.ts';
import {
  ABSENCE_EVIDENCE_SCHEMA,
  localFileEnoentEvidence,
} from '../src/evidence.ts';
import type {
  AbsenceEvidenceCertificate,
  GitHubCommitStatusPostcondition,
  KubernetesConfigMapExistsPostcondition,
  Observation,
  Postcondition,
} from '../src/model.ts';
import {
  authoritativeAbsenceEvidence,
  observationAuthoritativelyAbsent,
  observationVerified,
} from '../src/observation.ts';
import {
  KUBERNETES_COMPLETE_LIST_ABSENCE,
  KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
} from '../src/providers/kubernetes-configmap.ts';

type FilePostcondition=Extract<
  Postcondition,
  {verifier:'file-content-equals/v1'|'eventually-consistent-file-content-equals/v1'}
>;

const filePostcondition=(verifier:FilePostcondition['verifier']):FilePostcondition=>({
  verifier,
  path:'/tmp/target.txt',
  content:'expected-content',
});

const fileObservation=(
  postcondition:FilePostcondition,
  overrides:Partial<Observation>={},
):Observation=>({
  verifier:postcondition.verifier,
  mutation_certainty:'present',
  path:postcondition.path,
  expected_sha256:sha256(postcondition.content),
  actual_sha256:sha256(postcondition.content),
  ...overrides,
});

const githubPostcondition=():GitHubCommitStatusPostcondition=>({
  verifier:'github-commit-status/v2',
  provider:'github',
  repository_id:123,
  repository_full_name:'Owner/Repo',
  commit_sha:'a'.repeat(40),
  context:'overcenter/test',
  expected_state:'success',
});

const githubObservation=(
  postcondition:GitHubCommitStatusPostcondition,
  overrides:Partial<Observation>={},
):Observation=>({
  verifier:postcondition.verifier,
  mutation_certainty:'present',
  provider:'github',
  repository_id:postcondition.repository_id,
  repository_full_name:'owner/repo',
  commit_sha:postcondition.commit_sha,
  context:postcondition.context,
  expected_state:postcondition.expected_state,
  actual_state:postcondition.expected_state,
  ...overrides,
});

const kubernetesPostcondition=():KubernetesConfigMapExistsPostcondition=>({
  verifier:'kubernetes-configmap-exists/v1',
  provider:'kubernetes',
  authority_id:'kind:test-cluster',
  api_group:'',
  resource:'configmaps',
  namespace:'proof',
  name:'target',
});

const kubernetesObservation=(
  postcondition:KubernetesConfigMapExistsPostcondition,
  overrides:Partial<Observation>={},
):Observation=>({
  verifier:postcondition.verifier,
  mutation_certainty:'present',
  provider:'kubernetes',
  authority_id:postcondition.authority_id,
  api_group:postcondition.api_group,
  resource:postcondition.resource,
  namespace:postcondition.namespace,
  name:postcondition.name,
  observed_uid:'uid-1',
  observed_resource_version:'17',
  ...overrides,
});

function kubernetesAbsenceEvidence(
  postcondition:KubernetesConfigMapExistsPostcondition,
):AbsenceEvidenceCertificate {
  const page={
    page:1,
    request_continue:null,
    response_continue:'',
    snapshot_resource_version:'17',
    schema_sha256:'a'.repeat(64),
    validated_paths:[
      'apiVersion',
      'kind',
      'metadata.resourceVersion',
      'items[].metadata.name',
      'items[].metadata.namespace',
      'items[].metadata.uid',
      'items[].metadata.resourceVersion',
    ],
    optional_absent_paths:['metadata.continue'],
  };
  return {
    schema:ABSENCE_EVIDENCE_SCHEMA,
    kind:KUBERNETES_COMPLETE_LIST_ABSENCE,
    subject:{
      provider:'kubernetes',
      authority_id:postcondition.authority_id,
      api_group:'',
      resource:'configmaps',
      namespace:postcondition.namespace,
      name:postcondition.name,
    },
    scope:{
      provider:'kubernetes',
      authority_id:postcondition.authority_id,
      api_group:'',
      resource:'configmaps',
      namespace:postcondition.namespace,
    },
    snapshot:{resource_version:'17'},
    completeness:{
      kind:'complete-list',
      page_count:1,
      terminal_continue:'',
      page_chain_digest:`sha256:${canonicalDigest([page])}`,
    },
    provenance:{
      provider:'kubernetes',
      authority_id:postcondition.authority_id,
      operation_id:KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
      pages:[page],
    },
  };
}

test('file verification requires present certainty and exact content digest',()=>{
  for(const verifier of [
    'file-content-equals/v1',
    'eventually-consistent-file-content-equals/v1',
  ] as const){
    const postcondition=filePostcondition(verifier);
    const matching=fileObservation(postcondition);
    assert.equal(observationVerified(postcondition,matching),true);

    assert.equal(
      observationVerified(
        postcondition,
        fileObservation(postcondition,{actual_sha256:'0'.repeat(64)}),
      ),
      false,
      `${verifier} must reject mismatched bytes`,
    );
    for(const certainty of ['absent','uncertain'] as const){
      assert.equal(
        observationVerified(
          postcondition,
          fileObservation(postcondition,{mutation_certainty:certainty}),
        ),
        false,
        `${verifier} must reject ${certainty} observations`,
      );
    }
  }
});

test('observation predicates fail closed on coordinate mismatch',()=>{
  const file=filePostcondition('file-content-equals/v1');
  assert.throws(
    ()=>observationVerified(
      file,
      fileObservation(file,{path:'/tmp/other.txt'}),
    ),
    /OBSERVATION_COORDINATE_MISMATCH/,
  );
  assert.throws(
    ()=>authoritativeAbsenceEvidence(
      file,
      fileObservation(file,{
        mutation_certainty:'absent',
        path:'/tmp/other.txt',
        absence_evidence:localFileEnoentEvidence('/tmp/other.txt'),
      }),
    ),
    /OBSERVATION_COORDINATE_MISMATCH/,
  );
  assert.throws(
    ()=>observationVerified(
      file,
      {...fileObservation(file),verifier:'github-commit-status/v2'},
    ),
    /OBSERVATION_VERIFIER_MISMATCH/,
  );
});

test('local-file absence is authoritative only with exact ENOENT evidence',()=>{
  const postcondition=filePostcondition('file-content-equals/v1');
  const certificate=localFileEnoentEvidence(postcondition.path);
  const observed=fileObservation(postcondition,{
    mutation_certainty:'absent',
    absence_evidence:certificate,
  });

  assert.equal(authoritativeAbsenceEvidence(postcondition,observed),certificate);
  assert.equal(observationAuthoritativelyAbsent(postcondition,observed),true);

  const wrongEvidence=fileObservation(postcondition,{
    mutation_certainty:'absent',
    absence_evidence:localFileEnoentEvidence('/tmp/other.txt'),
  });
  assert.equal(authoritativeAbsenceEvidence(postcondition,wrongEvidence),null);
  assert.equal(observationAuthoritativelyAbsent(postcondition,wrongEvidence),false);

  for(const certainty of ['present','uncertain'] as const){
    const notAbsent=fileObservation(postcondition,{
      mutation_certainty:certainty,
      absence_evidence:certificate,
    });
    assert.equal(authoritativeAbsenceEvidence(postcondition,notAbsent),null);
    assert.equal(observationAuthoritativelyAbsent(postcondition,notAbsent),false);
  }
});

test('eventually-consistent file and GitHub status do not infer authoritative absence',()=>{
  const eventual=filePostcondition('eventually-consistent-file-content-equals/v1');
  const eventualObserved=fileObservation(eventual,{
    mutation_certainty:'absent',
    absence_evidence:localFileEnoentEvidence(eventual.path),
  });
  assert.equal(authoritativeAbsenceEvidence(eventual,eventualObserved),null);
  assert.equal(observationAuthoritativelyAbsent(eventual,eventualObserved),false);

  const github=githubPostcondition();
  const githubObserved=githubObservation(github,{mutation_certainty:'absent'});
  assert.equal(authoritativeAbsenceEvidence(github,githubObserved),null);
  assert.equal(observationAuthoritativelyAbsent(github,githubObserved),false);
});

test('Kubernetes absence requires a complete certificate bound to the exact object coordinate',()=>{
  const postcondition=kubernetesPostcondition();
  const certificate=kubernetesAbsenceEvidence(postcondition);
  const observed=kubernetesObservation(postcondition,{
    mutation_certainty:'absent',
    absence_evidence:certificate,
    observed_uid:undefined,
    observed_resource_version:undefined,
  });

  assert.equal(authoritativeAbsenceEvidence(postcondition,observed),certificate);
  assert.equal(observationAuthoritativelyAbsent(postcondition,observed),true);

  const wrongName:AbsenceEvidenceCertificate={
    ...certificate,
    subject:{...certificate.subject,name:'other'},
  };
  const mismatched=kubernetesObservation(postcondition,{
    mutation_certainty:'absent',
    absence_evidence:wrongName,
    observed_uid:undefined,
    observed_resource_version:undefined,
  });
  assert.equal(authoritativeAbsenceEvidence(postcondition,mismatched),null);
  assert.equal(observationAuthoritativelyAbsent(postcondition,mismatched),false);

  const present=kubernetesObservation(postcondition,{
    mutation_certainty:'present',
    absence_evidence:certificate,
  });
  assert.equal(authoritativeAbsenceEvidence(postcondition,present),null);
  assert.equal(observationAuthoritativelyAbsent(postcondition,present),false);
});

test('Kubernetes verification requires both non-empty UID and resourceVersion',()=>{
  const postcondition=kubernetesPostcondition();
  assert.equal(
    observationVerified(postcondition,kubernetesObservation(postcondition)),
    true,
  );

  const invalid:Array<[string,Partial<Observation>]>=[
    ['missing uid',{observed_uid:undefined}],
    ['empty uid',{observed_uid:''}],
    ['missing resource version',{observed_resource_version:undefined}],
    ['empty resource version',{observed_resource_version:''}],
    ['uncertain certainty',{mutation_certainty:'uncertain'}],
    ['absent certainty',{mutation_certainty:'absent'}],
  ];
  for(const [name,overrides] of invalid){
    assert.equal(
      observationVerified(
        postcondition,
        kubernetesObservation(postcondition,overrides),
      ),
      false,
      name,
    );
  }
});

test('GitHub status verification binds the observed state to the expected state',()=>{
  const postcondition=githubPostcondition();
  assert.equal(
    observationVerified(postcondition,githubObservation(postcondition)),
    true,
  );
  assert.equal(
    observationVerified(
      postcondition,
      githubObservation(postcondition,{actual_state:'failure'}),
    ),
    false,
  );
  assert.equal(
    observationVerified(
      postcondition,
      githubObservation(postcondition,{mutation_certainty:'uncertain'}),
    ),
    false,
  );
});
