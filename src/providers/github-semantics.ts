import type { GitHubCommitStatusPostcondition } from '../model.ts';
import { canonicalDigest } from '../digest.ts';
import type {
  EffectEquivalenceWitness,
  EffectSemantics,
  SettlementSemantics,
} from '../semantics-contract.ts';
import type { ResponseFieldSpec } from '../provider-observation/response-slice.ts';
import { githubStatusContextKey } from './github-rest.ts';
import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './github-contract.ts';

export interface GithubSemanticOperation {
  operation_id:string;
  response_slice:readonly ResponseFieldSpec[];
}

export const GITHUB_OPERATION_SEMANTICS={
  repository:{
    operation_id:'repos/get',
    response_slice:[
      {path:'id'},
      {path:'node_id'},
      {path:'full_name'},
      {path:'name'},
      {path:'owner.login'},
    ],
  },
  ref:{
    operation_id:'git/get-ref',
    response_slice:[
      {path:'ref'},
      {path:'object.type'},
      {path:'object.sha'},
    ],
  },
  pull_request:{
    operation_id:'pulls/get',
    response_slice:[
      {path:'id'},
      {path:'node_id'},
      {path:'number'},
      {path:'state'},
      {path:'head.sha'},
      {path:'base.ref'},
      {path:'base.sha'},
    ],
  },
  commit_statuses:{
    operation_id:'repos/list-commit-statuses-for-ref',
    response_slice:[
      {path:'[].id'},
      {path:'[].node_id'},
      {path:'[].state'},
      {path:'[].context'},
      {path:'[].target_url'},
      {path:'[].created_at'},
      {path:'[].updated_at'},
    ],
  },
} as const satisfies Record<string,GithubSemanticOperation>;

export const GITHUB_REPOSITORY_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.repository.response_slice;
export const GITHUB_REF_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.ref.response_slice;
export const GITHUB_PULL_REQUEST_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.pull_request.response_slice;
export const GITHUB_COMMIT_STATUS_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.commit_statuses.response_slice;

export const GITHUB_STATUS_COORDINATE_CONTRACT=
  'github-commit-status-coordinate/v1' as const;
export const GITHUB_STATUS_OPERATION_CLASS=
  `github-rest:create-commit-status@${GITHUB_API_VERSION}` as const;
export const EFFECT_EQUIVALENCE_ISSUER_CONTRACT=
  'overcenter/provider-effect-equivalence-issuer/v1' as const;
export const EFFECT_EQUIVALENCE_CERTIFICATE_SCHEMA=
  'overcenter-effect-equivalence-certificate-v1' as const;

function githubStatusObservationContract(
  postcondition:GitHubCommitStatusPostcondition,
):'github-commit-status-observation/v1'|'github-commit-status-observation/v2' {
  return postcondition.verifier==='github-commit-status/v1'
    ? 'github-commit-status-observation/v1'
    : 'github-commit-status-observation/v2';
}

export function githubCommitStatusEffectSemantics(
  postcondition:GitHubCommitStatusPostcondition,
):EffectSemantics {
  return {
    resource:`github-status:${postcondition.repository_id}:${postcondition.commit_sha}:${githubStatusContextKey(postcondition.context)}`,
    desired:postcondition.expected_state,
  };
}

export function githubCommitStatusSettlementSemantics(
  postcondition:GitHubCommitStatusPostcondition,
):SettlementSemantics {
  return {
    verifier:postcondition.verifier,
    acceptedAbsenceEvidenceKinds:[],
  };
}

export function githubCommitStatusEffectEquivalenceWitness(
  postcondition:GitHubCommitStatusPostcondition,
):EffectEquivalenceWitness {
  const effect=githubCommitStatusEffectSemantics(postcondition);
  const settlement=githubCommitStatusSettlementSemantics(postcondition);
  const contract={
    provider:'github' as const,
    verifier_contract:postcondition.verifier,
    coordinate_contract:GITHUB_STATUS_COORDINATE_CONTRACT,
    observation_contract:githubStatusObservationContract(postcondition),
    operation_class:GITHUB_STATUS_OPERATION_CLASS,
    provider_contract_digest:canonicalDigest({
      api_version:GITHUB_API_VERSION,
      openapi_sha256:GITHUB_OPENAPI_SHA256,
      openapi_source_commit:GITHUB_OPENAPI_SOURCE_COMMIT,
      method:'POST',
      path_template:'/repos/{owner}/{repo}/statuses/{sha}',
    }),
  };
  const payload={
    schema:EFFECT_EQUIVALENCE_CERTIFICATE_SCHEMA,
    issuer_contract:EFFECT_EQUIVALENCE_ISSUER_CONTRACT,
    ...contract,
    resource:effect.resource,
    operation:effect.desired,
    equivalence_class:'same-desired-under-overcenter-settlement',
    effect_semantics_digest:canonicalDigest({contract,effect}),
    settlement_semantics_digest:canonicalDigest({contract,settlement}),
  };
  return {
    ...payload,
    certificate_digest:canonicalDigest(payload),
  };
}
