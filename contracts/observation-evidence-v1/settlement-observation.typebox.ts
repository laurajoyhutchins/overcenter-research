import Type from 'typebox';

import type {AbsenceEvidenceCertificate,Data} from '../../src/model.ts';

const stringEnum=<const T extends readonly string[]>(values:T)=>
  Type.Unsafe<T[number]>({enum:[...values]});

export const VerifierKind=stringEnum([
  'file-content-equals/v1',
  'eventually-consistent-file-content-equals/v1',
  'github-commit-status/v2',
  'kubernetes-configmap-exists/v1',
] as const);

export const SettlementObservation=Type.Object({
  verifier:VerifierKind,
  mutation_certainty:stringEnum([
    'present',
    'absent',
    'uncertain',
  ] as const),
  absence_evidence:Type.Optional(
    Type.Unsafe<AbsenceEvidenceCertificate>({
      $ref:'#/$defs/AbsenceEvidenceEnvelope',
    }),
  ),
  path:Type.Optional(Type.String()),
  expected_sha256:Type.Optional(Type.String()),
  actual_sha256:Type.Optional(Type.String()),
  provider:Type.Optional(stringEnum(['github','kubernetes'] as const)),
  authority_id:Type.Optional(Type.String()),
  api_group:Type.Optional(Type.String()),
  resource:Type.Optional(Type.String()),
  namespace:Type.Optional(Type.String()),
  name:Type.Optional(Type.String()),
  observed_uid:Type.Optional(Type.String()),
  observed_resource_version:Type.Optional(Type.String()),
  snapshot_resource_version:Type.Optional(Type.String()),
  repository_id:Type.Optional(Type.Integer({
    minimum:1,
    maximum:Number.MAX_SAFE_INTEGER,
  })),
  repository_full_name:Type.Optional(Type.String()),
  commit_sha:Type.Optional(Type.String()),
  context:Type.Optional(Type.String()),
  expected_state:Type.Optional(Type.String()),
  actual_state:Type.Optional(Type.String()),
  observation_error:Type.Optional(Type.String()),
  provider_evidence:Type.Optional(
    Type.Unsafe<Data>({
      type:'object',
      additionalProperties:true,
      'x-overcenter-providerOwned':true,
    }),
  ),
},{additionalProperties:false});

export type Observation=Type.Static<typeof SettlementObservation>;
