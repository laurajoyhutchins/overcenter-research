import { canonicalDigest } from '../digest.ts';
import type {
  AbsenceEvidenceCertificate,
  Observation,
  Obligation,
} from '../model.ts';
import {
  EFFECT_TRACKING_PROTOCOL,
  type EffectReservation,
} from './facts.ts';
import {
  validateAbsenceEvidenceEnvelope,
} from '../observation/evidence.ts';
import { hasExactKeys as exactKeys } from '../validation.ts';

export const EFFECT_NONOCCURRENCE_EVIDENCE=
  'overcenter-effect-dispatch-not-observed' as const;

const proofSpec={
  domain:'overcenter-effect-nonoccurrence-proof',
  rule:'tracked-reservation && no-dispatch-record',
  protocol:EFFECT_TRACKING_PROTOCOL,
} as const;

export const EFFECT_NONOCCURRENCE_PROOF_DIGEST=canonicalDigest(proofSpec);

function effectContract(work:Obligation):string|null {
  const value=work.packet.effect_contract;
  return typeof value==='string' && value.length>0 ? value : null;
}

export function effectNonoccurrenceTopologyId(work:Obligation):string {
  return canonicalDigest({
    domain:'overcenter-effect-dispatch-topology',
    effect_contract:effectContract(work),
    postcondition_verifier:work.postcondition.verifier,
    protocol:EFFECT_TRACKING_PROTOCOL,
  });
}

function witnessDigest(
  work:Obligation,
  reservation:EffectReservation,
):string {
  return canonicalDigest({
    domain:'overcenter-effect-nonoccurrence-witness',
    run_id:reservation.run_id,
    obligation_id:reservation.obligation_id,
    execution_generation:reservation.execution_generation,
    execution_authority_commit:reservation.execution_authority_commit,
    reservation_commit:reservation.reservation_commit,
    topology_id:effectNonoccurrenceTopologyId(work),
    proof_digest:EFFECT_NONOCCURRENCE_PROOF_DIGEST,
  });
}

export function effectNonoccurrenceEvidence(
  work:Obligation,
  reservation:EffectReservation,
):AbsenceEvidenceCertificate {
  return {
    schema:'overcenter-absence-evidence-v1',
    kind:EFFECT_NONOCCURRENCE_EVIDENCE,
    subject:{
      kind:'effect-reservation',
      run_id:reservation.run_id,
      obligation_id:reservation.obligation_id,
      execution_generation:reservation.execution_generation,
      execution_authority_commit:reservation.execution_authority_commit,
      reservation_commit:reservation.reservation_commit,
    },
    scope:{
      kind:'trusted-effect-dispatch-boundary',
      effect_contract:effectContract(work),
      postcondition_verifier:work.postcondition.verifier,
      topology_id:effectNonoccurrenceTopologyId(work),
    },
    snapshot:null,
    completeness:{
      kind:'tracked-authority-history',
      protocol:EFFECT_TRACKING_PROTOCOL,
      tracking_record:'present',
      dispatch_record:'absent',
    },
    provenance:{
      authority:'overcenter-kernel',
      operation:'KernelCore.performEffect',
      proof_digest:EFFECT_NONOCCURRENCE_PROOF_DIGEST,
      witness_digest:witnessDigest(work,reservation),
    },
  };
}

export function effectNonoccurrenceEvidenceMatches(
  value:unknown,
  work:Obligation,
  reservation:EffectReservation,
):value is AbsenceEvidenceCertificate {
  try {
    validateAbsenceEvidenceEnvelope(value);
  } catch {
    return false;
  }
  if (value.kind!==EFFECT_NONOCCURRENCE_EVIDENCE) return false;
  if (!exactKeys(value.subject,[
    'kind',
    'run_id',
    'obligation_id',
    'execution_generation',
    'execution_authority_commit',
    'reservation_commit',
  ])) return false;
  if (!exactKeys(value.scope,[
    'kind',
    'effect_contract',
    'postcondition_verifier',
    'topology_id',
  ])) return false;
  if (!exactKeys(value.completeness,[
    'kind',
    'protocol',
    'tracking_record',
    'dispatch_record',
  ])) return false;
  if (!exactKeys(value.provenance,[
    'authority',
    'operation',
    'proof_digest',
    'witness_digest',
  ])) return false;

  return value.subject.kind==='effect-reservation'
    && value.subject.run_id===reservation.run_id
    && value.subject.obligation_id===reservation.obligation_id
    && value.subject.execution_generation===reservation.execution_generation
    && value.subject.execution_authority_commit===reservation.execution_authority_commit
    && value.subject.reservation_commit===reservation.reservation_commit
    && value.scope.kind==='trusted-effect-dispatch-boundary'
    && value.scope.effect_contract===effectContract(work)
    && value.scope.postcondition_verifier===work.postcondition.verifier
    && value.scope.topology_id===effectNonoccurrenceTopologyId(work)
    && value.snapshot===null
    && value.completeness.kind==='tracked-authority-history'
    && value.completeness.protocol===EFFECT_TRACKING_PROTOCOL
    && value.completeness.tracking_record==='present'
    && value.completeness.dispatch_record==='absent'
    && value.provenance.authority==='overcenter-kernel'
    && value.provenance.operation==='KernelCore.performEffect'
    && value.provenance.proof_digest===EFFECT_NONOCCURRENCE_PROOF_DIGEST
    && value.provenance.witness_digest===witnessDigest(work,reservation);
}

export function effectNonoccurrenceObservation(
  work:Obligation,
  reservation:EffectReservation,
):Observation {
  const evidence=effectNonoccurrenceEvidence(work,reservation);
  const p=work.postcondition;
  const common={
    verifier:p.verifier,
    mutation_certainty:'uncertain' as const,
    absence_evidence:evidence,
  };

  if (
    p.verifier==='file-content-equals/v1'
    || p.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    return {...common,path:p.path} as Observation;
  }
  if (p.verifier==='kubernetes-configmap-exists/v1') {
    return {
      ...common,
      provider:'kubernetes',
      authority_id:p.authority_id,
      api_group:p.api_group,
      resource:p.resource,
      namespace:p.namespace,
      name:p.name,
    } as Observation;
  }
  if (p.verifier==='github-pull-request-branch-updated/v1') {
    return {
      ...common,
      provider:'github',
      repository_id:p.repository_id,
      repository_full_name:p.repository_full_name,
      pull_number:p.pull_number,
      pull_node_id:p.pull_node_id,
      expected_previous_head_sha:p.expected_previous_head_sha,
      base_ref:p.base_ref,
      expected_base_sha:p.expected_base_sha,
    } as Observation;
  }
  return {
    ...common,
    provider:'github',
    repository_id:p.repository_id,
    repository_full_name:p.repository_full_name,
    commit_sha:p.commit_sha,
    context:p.context,
    expected_state:p.expected_state,
  } as Observation;
}
