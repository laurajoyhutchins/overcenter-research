import type { Obligation } from './model.ts';
import {
  authoritativeAbsenceEvidence,
  observationVerified,
} from './observation.ts';
import {
  emptyState,
  validateClaimFact,
  validateEffectReservationFact,
  materializeObligation,
  validateExecutionAuthorityFact,
  validateGraphPatchFact,
  validateReceiptFact,
} from './facts.ts';
import type {
  ClaimFact,
  EffectReservation,
  EffectReservationFact,
  ExecutionAuthorityFact,
  FactCommit,
  HistoricalRun,
  ObligationDefinition,
  Receipt,
  ReceiptFact,
  State,
} from './facts.ts';
import {
  dependencyUpstreams,
  validateGraph,
} from './graph.ts';
import { settlementSemantics } from './semantics.ts';
import { effectReservationAuthorityError, executionAuthorityAdvanceError, receiptAuthorityError } from './transaction-admission.ts';
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
  definitions:Record<string,ObligationDefinition>;
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
  const definitions:Record<string,ObligationDefinition>={};
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
    if (record.graph_patch!=null) {
      refresh(record.parent??'');
      if (hasInFlight(project)) throw new Error('GRAPH_PATCH_WHILE_IN_FLIGHT');

      const patch=validateGraphPatchFact(record.graph_patch);
      for (const introduced of patch.definitions) {
        if (definitions[introduced.id]) {
          throw new Error(`DUPLICATE_DEFINITION:${introduced.id}`);
        }
        definitions[introduced.id]=structuredClone(introduced.definition);
      }

      for (const id of patch.retire) {
        if (!state.obligations[id]) {
          throw new Error(`RETIRE_UNKNOWN_OBLIGATION:${id}`);
        }
        delete state.obligations[id];
        delete state.definition_ids[id];
      }

      for (const binding of patch.bindings) {
        const definition=definitions[binding.definition_id];
        if (!definition) {
          throw new Error(`UNKNOWN_OBLIGATION_DEFINITION:${binding.definition_id}`);
        }
        state.obligations[binding.node_id]=materializeObligation(
          binding.node_id,
          definition,
        );
        state.definition_ids[binding.node_id]=binding.definition_id;
      }

      validateGraph(state);
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
        definition_id:state.definition_ids[claim.obligation_id],
      };
      runs.set(run.id,run);
    }

    if (record.execution_authority!=null) {
      const fact=validateExecutionAuthorityFact(record.execution_authority);
      const run=runs.get(fact.run_id);
      if (!run) throw new Error('EXECUTION_AUTHORITY_WITHOUT_CLAIM');
      const authorityError=executionAuthorityAdvanceError(run,fact);
      if (authorityError) throw new Error(authorityError);
      refresh(record.commit);
      const current=project.lifecycles.get(run.obligation_id);
      if (
        current?.run?.id!==run.id
        || !['EXECUTING','WAITING','RECOVERY_REQUIRED'].includes(current.status)
      ) {
        throw new Error('EXECUTION_AUTHORITY_FOR_NONCURRENT_RUN');
      }
      runs.set(run.id,{
        ...run,
        execution_generation:fact.generation,
        execution_authority_commit:record.commit,
        execution_capability_sha256:fact.execution_capability_sha256,
      });
    }

    if (record.effect_reservation!=null) {
      const fact=validateEffectReservationFact(record.effect_reservation);
      const run=runs.get(fact.run_id);
      if (!run) throw new Error('EFFECT_RESERVATION_WITHOUT_CLAIM');
      const authorityError=effectReservationAuthorityError(
        run,
        fact,
        unresolvedReservationsByRun.has(run.id),
      );
      if (authorityError) throw new Error(authorityError);
      refresh(record.commit);
      const current=project.lifecycles.get(run.obligation_id);
      if (current?.run?.id!==run.id || current.status!=='EXECUTING') {
        throw new Error('EFFECT_RESERVATION_WHILE_NOT_EXECUTING');
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
    const receiptError=receiptAuthorityError(run,fact);
    if (receiptError) throw new Error(receiptError);

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
  }

  const revision=commits.at(-1)?.commit??'';
  refresh(revision);
  return {
    state,
    definitions,
    project,
    history:{
      runs,
      receiptsByRun,
      unresolvedReservationsByRun,
      receipts,
    },
  };
}
