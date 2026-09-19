import type { Obligation } from './model.ts';
import {
  authoritativeAbsenceEvidence,
  observationVerified,
} from './observation.ts';
import {
  CLAIM_SCHEMA,
  COMPUTATION_ATTEMPT_SCHEMA,
  COMPUTATION_INTENT_SCHEMA,
  EFFECT_RESERVATION_SCHEMA,
  EXECUTION_AUTHORITY_SCHEMA,
  LEGACY_RECEIPT_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
  emptyState,
  validateStoredObligation,
} from './facts.ts';
import type {
  ClaimFact,
  ComputationAttempt,
  ComputationAttemptFact,
  ComputationIntent,
  ComputationIntentFact,
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
  deriveLifecycles,
  hasInFlight,
  obligationKey,
} from './lifecycle.ts';
import type { Lifecycle } from './lifecycle.ts';
import {
  validateComputationEvidence,
  validateEncodedProcessSpec,
} from './computation-execution.ts';

export interface HistoryProjection {
  lifecycles:Map<string,Lifecycle>;
  runs:Map<string,HistoricalRun>;
  receiptsByRun:Map<string,Receipt>;
  unresolvedReservationsByRun:Map<string,EffectReservation>;
  computationIntentsByExecution:Map<string,ComputationIntent>;
  computationAttemptsByIntent:Map<string,ComputationAttempt>;
  computationIntents:ComputationIntent[];
  computationAttempts:ComputationAttempt[];
  receipts:Receipt[];
}

export interface Projection {
  state:State;
  history:HistoryProjection;
}

const executionKey=(
  runId:string,
  generation:number,
  authorityCommit:string,
)=>[runId,generation,authorityCommit].join('/');

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
  const unresolvedReservationsByRun=new Map<string,EffectReservation>();
  const computationIntentsByExecution=new Map<string,ComputationIntent>();
  const computationAttemptsByIntent=new Map<string,ComputationAttempt>();
  const computationIntents:ComputationIntent[]=[];
  const computationAttempts:ComputationAttempt[]=[];
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

    if (record.computation_intent!=null) {
      const fact=record.computation_intent as ComputationIntentFact;
      if (fact.schema!==COMPUTATION_INTENT_SCHEMA) {
        throw new Error('INVALID_COMPUTATION_INTENT_SCHEMA');
      }
      const run=runs.get(fact.run_id);
      if (!run) throw new Error('COMPUTATION_INTENT_WITHOUT_CLAIM');
      if (run.obligation_id!==fact.obligation_id) {
        throw new Error('COMPUTATION_INTENT_OBLIGATION_MISMATCH');
      }
      if (fact.claimed_revision!==run.claimed_revision) {
        throw new Error('COMPUTATION_INTENT_REVISION_MISMATCH');
      }
      if (fact.claim_commit!==run.claim_commit) {
        throw new Error('COMPUTATION_INTENT_CLAIM_MISMATCH');
      }
      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
      const current=lifecycles.get(run.obligation_id);
      if (current?.run?.id!==run.id || current.status!=='EXECUTING') {
        throw new Error('COMPUTATION_INTENT_WHILE_NOT_EXECUTING');
      }
      if (
        fact.execution_generation!==run.execution_generation
        || fact.execution_authority_commit!==run.execution_authority_commit
        || fact.execution_capability_sha256!==run.execution_capability_sha256
      ) {
        throw new Error('STALE_COMPUTATION_INTENT');
      }
      if (unresolvedReservationsByRun.has(run.id)) {
        throw new Error('COMPUTATION_INTENT_AFTER_EFFECT_RESERVATION');
      }
      validateEncodedProcessSpec(
        fact.execution_spec_base64,
        fact.execution_spec_sha256,
      );
      const key=executionKey(
        run.id,
        run.execution_generation,
        run.execution_authority_commit,
      );
      if (computationIntentsByExecution.has(key)) {
        throw new Error('DUPLICATE_COMPUTATION_INTENT');
      }
      const intent:ComputationIntent={
        ...fact,
        intent_commit:record.commit,
      };
      computationIntentsByExecution.set(key,intent);
      computationIntents.push(intent);
    }

    if (record.computation_attempt!=null) {
      const fact=record.computation_attempt as ComputationAttemptFact;
      if (fact.schema!==COMPUTATION_ATTEMPT_SCHEMA) {
        throw new Error('INVALID_COMPUTATION_ATTEMPT_SCHEMA');
      }
      if (
        typeof fact.recorded_at!=='string'
        || !Number.isFinite(Date.parse(fact.recorded_at))
      ) {
        throw new Error('INVALID_COMPUTATION_ATTEMPT_TIME');
      }
      const run=runs.get(fact.run_id);
      if (!run) throw new Error('COMPUTATION_ATTEMPT_WITHOUT_CLAIM');
      if (run.obligation_id!==fact.obligation_id) {
        throw new Error('COMPUTATION_ATTEMPT_OBLIGATION_MISMATCH');
      }
      const evidence=validateComputationEvidence(fact.evidence);
      const key=executionKey(
        evidence.run_id,
        evidence.execution_generation,
        evidence.execution_authority_commit,
      );
      const intent=computationIntentsByExecution.get(key);
      if (!intent) throw new Error('COMPUTATION_ATTEMPT_WITHOUT_INTENT');
      if (fact.computation_intent_commit!==intent.intent_commit) {
        throw new Error('COMPUTATION_ATTEMPT_INTENT_MISMATCH');
      }
      if (
        evidence.run_id!==run.id
        || evidence.obligation_id!==run.obligation_id
        || evidence.claimed_revision!==run.claimed_revision
        || evidence.execution_generation!==run.execution_generation
        || evidence.execution_authority_commit!==run.execution_authority_commit
        || evidence.execution_capability_sha256!==run.execution_capability_sha256
        || evidence.execution_spec_sha256!==intent.execution_spec_sha256
      ) {
        throw new Error('COMPUTATION_ATTEMPT_AUTHORITY_MISMATCH');
      }
      lifecycles=deriveLifecycles(state,runs,receiptsByRun);
      const current=lifecycles.get(run.obligation_id);
      if (current?.run?.id!==run.id || current.status!=='EXECUTING') {
        throw new Error('COMPUTATION_ATTEMPT_WHILE_NOT_EXECUTING');
      }
      if (computationAttemptsByIntent.has(intent.intent_commit)) {
        throw new Error('DUPLICATE_COMPUTATION_ATTEMPT');
      }
      const attempt:ComputationAttempt={
        ...fact,
        evidence,
        attempt_commit:record.commit,
      };
      computationAttemptsByIntent.set(intent.intent_commit,attempt);
      computationAttempts.push(attempt);
    }

    if (record.effect_reservation!=null) {
      const fact=record.effect_reservation as EffectReservationFact;
      if (fact.schema!==EFFECT_RESERVATION_SCHEMA) {
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
      const key=executionKey(
        run.id,
        run.execution_generation,
        run.execution_authority_commit,
      );
      if (computationIntentsByExecution.has(key)) {
        throw new Error('EFFECT_RESERVATION_AFTER_COMPUTATION_INTENT');
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
      unresolvedReservationsByRun,
      computationIntentsByExecution,
      computationAttemptsByIntent,
      computationIntents,
      computationAttempts,
      receipts,
    },
  };
}
