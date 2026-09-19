import type { Obligation } from './model.ts';
import {
  authoritativeAbsenceEvidence,
  observationVerified,
} from './observation.ts';
import {
  CLAIM_SCHEMA,
  EFFECT_RESERVATION_SCHEMA,
  LEGACY_EFFECT_RESERVATION_SCHEMA,
  EXECUTION_AUTHORITY_SCHEMA,
  REALIZATION_SCHEMA,
  LEGACY_RECEIPT_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
  emptyState,
  validateStoredObligation,
} from './facts.ts';
import type {
  ClaimFact,
  AcceptedRealization,
  EffectReservation,
  EffectReservationFact,
  ExecutionAuthorityFact,
  FactCommit,
  HistoricalRun,
  ObligationFact,
  RealizationFact,
  Receipt,
  ReceiptFact,
  State,
} from './facts.ts';
import {
  dependencyUpstreams,
  validateGraph,
} from './graph.ts';
import { settlementSemantics } from './semantics.ts';
import {
  deriveLifecycles,
  hasInFlight,
  obligationKey,
} from './lifecycle.ts';
import type { Lifecycle } from './lifecycle.ts';
import { derivePinnedProviderEffect } from './provider-effect.ts';

export interface HistoryProjection {
  lifecycles:Map<string,Lifecycle>;
  runs:Map<string,HistoricalRun>;
  receiptsByRun:Map<string,Receipt>;
  acceptedRealizationsByRun:Map<string,AcceptedRealization>;
  unresolvedReservationsByRun:Map<string,EffectReservation>;
  receipts:Receipt[];
}

export interface Projection {
  state:State;
  history:HistoryProjection;
}

export function projectReceipt(
  fact:ReceiptFact,
  work:Obligation,
  settlementCommit?:string,
):Receipt {
  let disposition:Receipt['disposition'];
  let verified=false;

  if (fact.kind==='observation') {
    if (!fact.observed) throw new Error('OBSERVATION_RECEIPT_MISSING_EVIDENCE');
    if (fact.schema===LEGACY_RECEIPT_SCHEMA) {
      verified=fact.observed.mutation_certainty==='present'
        ? observationVerified(work.postcondition,fact.observed)
        : false;
      disposition=verified
        ? 'DONE'
        : fact.observed.mutation_certainty==='absent'
          ? 'READY'
          : 'RECOVERY_REQUIRED';
    } else {
      verified=observationVerified(work.postcondition,fact.observed);
      const policy=settlementSemantics(work.postcondition);
      const absenceEvidence=authoritativeAbsenceEvidence(
        work.postcondition,
        fact.observed,
      );
      disposition=verified
        ? 'DONE'
        : absenceEvidence
          && policy.acceptedAbsenceEvidenceKinds.includes(absenceEvidence.kind)
          ? 'READY'
          : 'RECOVERY_REQUIRED';
    }
  } else {
    if (fact.observed) throw new Error('NONOBSERVATION_RECEIPT_HAS_EVIDENCE');
    disposition=fact.kind==='judgment-required' ? 'WAITING' : 'RECOVERY_REQUIRED';
  }

  return {
    ...fact,
    disposition,
    verified,
    ...(settlementCommit?{settlement_commit:settlementCommit}:{}),
  };
}

export function replayProjection(commits:FactCommit[]):Projection {
  const state=emptyState();
  let lifecycles=new Map<string,Lifecycle>();
  const runs=new Map<string,HistoricalRun>();
  const receiptsByRun=new Map<string,Receipt>();
  const acceptedRealizationsByRun=new Map<string,AcceptedRealization>();
  const unresolvedReservationsByRun=new Map<string,EffectReservation>();
  const receipts:Receipt[]=[];

  for (const record of commits) {
    if (record.obligation!=null) {
      const fact=record.obligation as ObligationFact;
      if (fact.schema!==OBLIGATION_SCHEMA) throw new Error('INVALID_OBLIGATION_SCHEMA');
      const obligation=validateStoredObligation(fact.obligation);
      const id=obligation.id;

      if (fact.kind==='defined') {
        if (state.obligations[id]) throw new Error(`DUPLICATE_OBLIGATION:${id}`);
      } else if (fact.kind==='amended') {
        if (!state.obligations[id]) throw new Error(`AMEND_UNKNOWN_OBLIGATION:${id}`);
        if (fact.previous_definition_commit!==state.definition_commits[id]) {
          throw new Error('AMEND_PREVIOUS_DEFINITION_MISMATCH');
        }
        if (hasInFlight(lifecycles)) throw new Error('AMEND_WHILE_IN_FLIGHT');
      } else {
        throw new Error('INVALID_OBLIGATION_KIND');
      }

      state.obligations[id]=obligation;
      state.definition_commits[id]=record.commit;
      validateGraph(state);
      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
    }

    if (record.claim!=null) {
      const claim=record.claim as ClaimFact;
      if (claim.schema!==CLAIM_SCHEMA) throw new Error('INVALID_CLAIM_SCHEMA');
      const obligation=state.obligations[claim.obligation_id];
      if (!obligation) throw new Error('CLAIM_FOR_UNKNOWN_OBLIGATION');
      if (runs.has(claim.run_id)) throw new Error('DUPLICATE_RUN');
      if (record.parent!==claim.claimed_revision) throw new Error('CLAIM_REVISION_MISMATCH');

      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
      const current=lifecycles.get(claim.obligation_id);
      if (current?.status!=='UNREALIZED') throw new Error('CLAIM_WHILE_NOT_READY');
      const unsatisfied=dependencyUpstreams(obligation)
        .filter(dependency=>lifecycles.get(dependency)?.status!=='DONE');
      if (unsatisfied.length>0) throw new Error('CLAIM_WITH_UNSATISFIED_DEPENDENCIES');

      const expectedKey=obligationKey(state,obligation,lifecycles,receiptsByRun);
      if (!expectedKey) throw new Error('CLAIM_WITH_UNRESOLVED_SEMANTIC_DEPENDENCY');
      if (claim.obligation_key!==expectedKey) throw new Error('CLAIM_OBLIGATION_KEY_MISMATCH');

      if (
        typeof claim.execution_capability_sha256!=='string'
        || !/^[0-9a-f]{64}$/.test(claim.execution_capability_sha256)
      ) {
        throw new Error('INVALID_EXECUTION_CAPABILITY_DIGEST');
      }

      const run:HistoricalRun={
        id:claim.run_id,
        obligation_id:claim.obligation_id,
        claimed_revision:claim.claimed_revision,
        claim_commit:record.commit,
        obligation_key:claim.obligation_key,
        execution_generation:1,
        execution_authority_commit:record.commit,
        execution_capability_sha256:claim.execution_capability_sha256,
        obligation:structuredClone(obligation),
        definition_commit:state.definition_commits[claim.obligation_id],
      };
      runs.set(run.id,run);
      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
    }

    if (record.execution_authority!=null) {
      const fact=record.execution_authority as ExecutionAuthorityFact;
      if (fact.schema!==EXECUTION_AUTHORITY_SCHEMA) {
        throw new Error('INVALID_EXECUTION_AUTHORITY_SCHEMA');
      }
      const run=runs.get(fact.run_id);
      if (!run) throw new Error('EXECUTION_AUTHORITY_WITHOUT_CLAIM');
      if (run.obligation_id!==fact.obligation_id) {
        throw new Error('EXECUTION_AUTHORITY_OBLIGATION_MISMATCH');
      }
      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
      const current=lifecycles.get(run.obligation_id);
      if (
        current?.run?.id!==run.id
        || !['EXECUTING','WAITING','RECOVERY_REQUIRED'].includes(current.status)
      ) {
        throw new Error('EXECUTION_AUTHORITY_FOR_NONCURRENT_RUN');
      }
      if (fact.generation!==run.execution_generation+1) {
        throw new Error('EXECUTION_GENERATION_NOT_SUCCESSOR');
      }
      if (fact.previous_authority_commit!==run.execution_authority_commit) {
        throw new Error('EXECUTION_AUTHORITY_PREDECESSOR_MISMATCH');
      }
      if (
        typeof fact.execution_capability_sha256!=='string'
        || !/^[0-9a-f]{64}$/.test(fact.execution_capability_sha256)
      ) {
        throw new Error('INVALID_EXECUTION_CAPABILITY_DIGEST');
      }
      runs.set(run.id,{
        ...run,
        execution_generation:fact.generation,
        execution_authority_commit:record.commit,
        execution_capability_sha256:fact.execution_capability_sha256,
      });
      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
    }

    if (record.realization!=null) {
      const fact=record.realization as RealizationFact;
      if (fact.schema!==REALIZATION_SCHEMA) {
        throw new Error('INVALID_REALIZATION_SCHEMA');
      }
      const run=runs.get(fact.run_id);
      if (!run) throw new Error('REALIZATION_WITHOUT_CLAIM');
      if (run.obligation_id!==fact.obligation_id) {
        throw new Error('REALIZATION_OBLIGATION_MISMATCH');
      }
      if (fact.claimed_revision!==run.claimed_revision) {
        throw new Error('REALIZATION_REVISION_MISMATCH');
      }
      if (
        fact.execution_generation!==run.execution_generation
        || fact.execution_authority_commit!==run.execution_authority_commit
      ) {
        throw new Error('REALIZATION_EXECUTION_AUTHORITY_MISMATCH');
      }
      const acceptance=run.obligation.result_acceptance;
      if (!acceptance) throw new Error('REALIZATION_WITHOUT_ACCEPTANCE_CONTRACT');
      if (fact.verifier!==acceptance.verifier) {
        throw new Error('REALIZATION_VERIFIER_MISMATCH');
      }
      if (
        !/^[0-9a-f]{64}$/.test(fact.result_digest)
        || fact.result_digest!==acceptance.expected_sha256
      ) {
        throw new Error('REALIZATION_RESULT_MISMATCH');
      }
      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
      const current=lifecycles.get(run.obligation_id);
      if (current?.run?.id!==run.id || current.status!=='EXECUTING') {
        throw new Error('REALIZATION_WHILE_NOT_EXECUTING');
      }
      if (unresolvedReservationsByRun.has(run.id)) {
        throw new Error('REALIZATION_AFTER_EFFECT_RESERVATION');
      }
      if (acceptedRealizationsByRun.has(run.id)) {
        throw new Error('DUPLICATE_ACCEPTED_REALIZATION');
      }
      acceptedRealizationsByRun.set(run.id,{
        ...fact,
        realization_commit:record.commit,
      });
    }

    if (record.effect_reservation!=null) {
      const fact=record.effect_reservation as EffectReservationFact;
      if (
        fact.schema!==EFFECT_RESERVATION_SCHEMA
        && fact.schema!==LEGACY_EFFECT_RESERVATION_SCHEMA
      ) {
        throw new Error('INVALID_EFFECT_RESERVATION_SCHEMA');
      }
      const run=runs.get(fact.run_id);
      if (!run) throw new Error('EFFECT_RESERVATION_WITHOUT_CLAIM');
      if (run.obligation_id!==fact.obligation_id) {
        throw new Error('EFFECT_RESERVATION_OBLIGATION_MISMATCH');
      }
      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
      const current=lifecycles.get(run.obligation_id);
      if (current?.run?.id!==run.id || current.status!=='EXECUTING') {
        throw new Error('EFFECT_RESERVATION_WHILE_NOT_EXECUTING');
      }
      if (
        fact.execution_generation!==run.execution_generation
        || fact.execution_authority_commit!==run.execution_authority_commit
      ) {
        throw new Error('STALE_EFFECT_RESERVATION');
      }
      if (fact.schema===LEGACY_EFFECT_RESERVATION_SCHEMA) {
        if (run.obligation.effect_authority) {
          throw new Error('LEGACY_EFFECT_RESERVATION_FOR_AUTHORIZED_EFFECT');
        }
      } else {
        const authority=run.obligation.effect_authority;
        if (!authority) throw new Error('EFFECT_RESERVATION_WITHOUT_AUTHORITY');
        const expectedEffect=derivePinnedProviderEffect(run.obligation);
        if (!expectedEffect) {
          throw new Error('EFFECT_RESERVATION_WITHOUT_DERIVABLE_EFFECT');
        }
        if (
          fact.effect_contract!==expectedEffect.effect_contract
          || fact.adapter_contract_digest!==expectedEffect.adapter_contract_digest
          || fact.effect_digest!==expectedEffect.effect_digest
        ) {
          throw new Error('EFFECT_RESERVATION_IDENTITY_MISMATCH');
        }
        const acceptance=run.obligation.result_acceptance;
        const realization=acceptedRealizationsByRun.get(run.id);
        if (acceptance) {
          if (!realization) throw new Error('EFFECT_RESERVATION_WITHOUT_REALIZATION');
          if (
            fact.realization_commit!==realization.realization_commit
            || fact.realization_digest!==realization.result_digest
          ) {
            throw new Error('EFFECT_RESERVATION_REALIZATION_MISMATCH');
          }
        } else if (
          fact.realization_commit!==null
          || fact.realization_digest!==null
        ) {
          throw new Error('UNEXPECTED_EFFECT_REALIZATION_BINDING');
        }
      }
      if (unresolvedReservationsByRun.has(run.id)) {
        throw new Error('DUPLICATE_UNRESOLVED_EFFECT');
      }
      unresolvedReservationsByRun.set(run.id,{
        ...fact,
        reservation_commit:record.commit,
      });
    }

    if (record.receipt==null) continue;
    const fact=record.receipt as ReceiptFact;
    if (
      fact.schema!==RECEIPT_SCHEMA
      && fact.schema!==LEGACY_RECEIPT_SCHEMA
    ) {
      throw new Error('INVALID_RECEIPT_SCHEMA');
    }
    if (!['observation','judgment-required','execution-terminated'].includes(fact.kind)) {
      throw new Error('INVALID_RECEIPT_KIND');
    }
    const run=runs.get(fact.run_id);
    if (!run) throw new Error('RECEIPT_WITHOUT_CLAIM');
    if (run.obligation_id!==fact.obligation_id) throw new Error('RECEIPT_OBLIGATION_MISMATCH');
    if (fact.claimed_revision!==run.claimed_revision) throw new Error('RECEIPT_REVISION_MISMATCH');
    if (fact.claim_commit!==run.claim_commit) throw new Error('RECEIPT_CLAIM_MISMATCH');
    if (
      fact.execution_generation!==run.execution_generation
      || fact.execution_authority_commit!==run.execution_authority_commit
    ) {
      throw new Error('RECEIPT_EXECUTION_AUTHORITY_MISMATCH');
    }

    lifecycles=deriveLifecycles(state,runs,receiptsByRun);
    const current=lifecycles.get(run.obligation_id);
    if (current?.run?.id!==run.id) throw new Error('RECEIPT_FOR_NONCURRENT_RUN');
    if (fact.kind==='judgment-required' && current.status!=='EXECUTING') {
      throw new Error('JUDGMENT_REQUIRED_WHILE_NOT_EXECUTING');
    }
    if (fact.kind==='judgment-required' && unresolvedReservationsByRun.has(run.id)) {
      throw new Error('JUDGMENT_REQUIRED_WITH_UNRESOLVED_EFFECT');
    }
    if (fact.kind==='execution-terminated' && current.status!=='EXECUTING') {
      throw new Error('EXECUTION_TERMINATED_WHILE_NOT_EXECUTING');
    }
    if (
      fact.kind==='observation'
      && !['EXECUTING','WAITING','RECOVERY_REQUIRED'].includes(current.status)
    ) {
      throw new Error('OBSERVATION_WHILE_NOT_RESOLVABLE');
    }
    const previous=receiptsByRun.get(run.id);
    if (previous && ['DONE','READY'].includes(previous.disposition)) {
      throw new Error('RECEIPT_AFTER_TERMINAL_SETTLEMENT');
    }

    const receipt=projectReceipt(fact,run.obligation,record.commit);
    receiptsByRun.set(run.id,receipt);
    if (receipt.disposition==='DONE' || receipt.disposition==='READY') {
      unresolvedReservationsByRun.delete(run.id);
    }
    receipts.push(receipt);
    lifecycles=deriveLifecycles(state,runs,receiptsByRun);
  }

  lifecycles=deriveLifecycles(state,runs,receiptsByRun);
  return {
    state,
    history:{
      lifecycles,
      runs,
      receiptsByRun,
      acceptedRealizationsByRun,
      unresolvedReservationsByRun,
      receipts,
    },
  };
}
