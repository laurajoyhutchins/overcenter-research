import type { Obligation } from './model.ts';
import {
  authoritativeAbsenceEvidence,
  observationVerified,
} from './observation.ts';
import {
  LEGACY_RECEIPT_SCHEMA,
  emptyState,
  validateClaimFact,
  validateEffectReservationFact,
  validateExecutionAuthorityFact,
  validateObligationFact,
  validateReceiptFact,
} from './facts.ts';
import type {
  ClaimFact,
  EffectReservation,
  EffectReservationFact,
  ExecutionAuthorityFact,
  FactCommit,
  HistoricalRun,
  ObligationFact,
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
  deriveProjectProjection,
  hasInFlight,
  type ProjectProjection as WorkProjection,
} from './projector.ts';

export interface HistoryProjection {
  runs:Map<string,HistoricalRun>;
  receiptsByRun:Map<string,Receipt>;
  unresolvedReservationsByRun:Map<string,EffectReservation>;
  receipts:Receipt[];
}

export interface Projection {
  state:State;
  project:WorkProjection;
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
  const runs=new Map<string,HistoricalRun>();
  const receiptsByRun=new Map<string,Receipt>();
  const unresolvedReservationsByRun=new Map<string,EffectReservation>();
  const receipts:Receipt[]=[];
  let project=deriveProjectProjection({
    state,
    runs,
    receiptsByRun,
    revision:'',
  });

  const refresh=(revision:string):void=>{
    project=deriveProjectProjection({
      state,
      runs,
      receiptsByRun,
      revision,
    });
  };

  for (const record of commits) {
    if (record.obligation!=null) {
      const fact=validateObligationFact(record.obligation);
      const obligation=fact.obligation;
      const id=obligation.id;

      if (fact.kind==='defined') {
        if (state.obligations[id]) throw new Error(`DUPLICATE_OBLIGATION:${id}`);
      } else if (fact.kind==='amended') {
        if (!state.obligations[id]) throw new Error(`AMEND_UNKNOWN_OBLIGATION:${id}`);
        if (fact.previous_definition_commit!==state.definition_commits[id]) {
          throw new Error('AMEND_PREVIOUS_DEFINITION_MISMATCH');
        }
        if (hasInFlight(project)) throw new Error('AMEND_WHILE_IN_FLIGHT');
      } else {
        throw new Error('INVALID_OBLIGATION_KIND');
      }

      state.obligations[id]=obligation;
      state.definition_commits[id]=record.commit;
      validateGraph(state);
      refresh(record.commit);
    }

    if (record.claim!=null) {
      const claim=validateClaimFact(record.claim);
      const obligation=state.obligations[claim.obligation_id];
      if (!obligation) throw new Error('CLAIM_FOR_UNKNOWN_OBLIGATION');
      if (runs.has(claim.run_id)) throw new Error('DUPLICATE_RUN');
      if (record.parent!==claim.claimed_revision) throw new Error('CLAIM_REVISION_MISMATCH');

      refresh(record.commit);
      const current=project.lifecycles.get(claim.obligation_id);
      if (current?.status!=='UNREALIZED') throw new Error('CLAIM_WHILE_NOT_READY');
      const unsatisfied=dependencyUpstreams(obligation)
        .filter(dependency=>project.lifecycles.get(dependency)?.status!=='DONE');
      if (unsatisfied.length>0) throw new Error('CLAIM_WITH_UNSATISFIED_DEPENDENCIES');

      const expectedKey=project.semanticKeys.get(claim.obligation_id);
      if (!expectedKey) throw new Error('CLAIM_WITH_UNRESOLVED_SEMANTIC_DEPENDENCY');
      if (claim.obligation_key!==expectedKey) throw new Error('CLAIM_OBLIGATION_KEY_MISMATCH');

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
      refresh(record.commit);
    }

    if (record.execution_authority!=null) {
      const fact=validateExecutionAuthorityFact(record.execution_authority);
      const run=runs.get(fact.run_id);
      if (!run) throw new Error('EXECUTION_AUTHORITY_WITHOUT_CLAIM');
      if (run.obligation_id!==fact.obligation_id) {
        throw new Error('EXECUTION_AUTHORITY_OBLIGATION_MISMATCH');
      }
      refresh(record.commit);
      const current=project.lifecycles.get(run.obligation_id);
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
      runs.set(run.id,{
        ...run,
        execution_generation:fact.generation,
        execution_authority_commit:record.commit,
        execution_capability_sha256:fact.execution_capability_sha256,
      });
      refresh(record.commit);
    }

    if (record.effect_reservation!=null) {
      const fact=validateEffectReservationFact(record.effect_reservation);
      const run=runs.get(fact.run_id);
      if (!run) throw new Error('EFFECT_RESERVATION_WITHOUT_CLAIM');
      if (run.obligation_id!==fact.obligation_id) {
        throw new Error('EFFECT_RESERVATION_OBLIGATION_MISMATCH');
      }
      refresh(record.commit);
      const current=project.lifecycles.get(run.obligation_id);
      if (current?.run?.id!==run.id || current.status!=='EXECUTING') {
        throw new Error('EFFECT_RESERVATION_WHILE_NOT_EXECUTING');
      }
      if (
        fact.execution_generation!==run.execution_generation
        || fact.execution_authority_commit!==run.execution_authority_commit
      ) {
        throw new Error('STALE_EFFECT_RESERVATION');
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
    const fact=validateReceiptFact(record.receipt);
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

    refresh(record.commit);
    const current=project.lifecycles.get(run.obligation_id);
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
    refresh(record.commit);
  }

  const revision=commits.at(-1)?.commit??'';
  refresh(revision);
  return {
    state,
    project,
    history:{
      runs,
      receiptsByRun,
      unresolvedReservationsByRun,
      receipts,
    },
  };
}
