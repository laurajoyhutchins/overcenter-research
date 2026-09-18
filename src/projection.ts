import type { Obligation } from './model.ts';
import { observationSatisfiesPostcondition } from './observation.ts';
import {
  CLAIM_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
  emptyObligationCatalog,
  validateStoredObligation,
} from './facts.ts';
import type {
  ClaimFact,
  FactCommit,
  HistoricalRun,
  ObligationFact,
  Receipt,
  ReceiptFact,
  ObligationCatalog,
} from './facts.ts';
import {
  dependencyUpstreams,
  validateGraph,
} from './graph.ts';
import {
  deriveLifecycles,
  hasInFlight,
  obligationKey,
} from './lifecycle.ts';
import type { Lifecycle } from './lifecycle.ts';

export interface HistoryProjection {
  lifecycles:Map<string,Lifecycle>;
  runs:Map<string,HistoricalRun>;
  receiptsByRun:Map<string,Receipt>;
  receipts:Receipt[];
}

export interface Projection {
  catalog:ObligationCatalog;
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
    verified=observationSatisfiesPostcondition(work.postcondition,fact.observed);
    disposition=verified
      ? 'DONE'
      : fact.observed.mutation_certainty==='absent'
        ? 'ABSENT'
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

export function reconstructProjection(commits:FactCommit[]):Projection {
  const catalog=emptyObligationCatalog();
  let lifecycles=new Map<string,Lifecycle>();
  const runs=new Map<string,HistoricalRun>();
  const receiptsByRun=new Map<string,Receipt>();
  const receipts:Receipt[]=[];

  for (const record of commits) {
    if (record.obligation!=null) {
      const fact=record.obligation as ObligationFact;
      if (fact.schema!==OBLIGATION_SCHEMA) throw new Error('INVALID_OBLIGATION_SCHEMA');
      const obligation=validateStoredObligation(fact.obligation);
      const id=obligation.id;

      if (fact.kind==='defined') {
        if (catalog.obligations[id]) throw new Error(`DUPLICATE_OBLIGATION:${id}`);
      } else if (fact.kind==='amended') {
        if (!catalog.obligations[id]) throw new Error(`AMEND_UNKNOWN_OBLIGATION:${id}`);
        if (fact.previous_definition_commit!==catalog.definition_commits[id]) {
          throw new Error('AMEND_PREVIOUS_DEFINITION_MISMATCH');
        }
        if (hasInFlight(lifecycles)) throw new Error('AMEND_WHILE_IN_FLIGHT');
      } else {
        throw new Error('INVALID_OBLIGATION_KIND');
      }

      catalog.obligations[id]=obligation;
      catalog.definition_commits[id]=record.commit;
      validateGraph(catalog);
      lifecycles=deriveLifecycles(catalog,runs,receiptsByRun);
    }

    if (record.claim!=null) {
      const claim=record.claim as ClaimFact;
      if (claim.schema!==CLAIM_SCHEMA) throw new Error('INVALID_CLAIM_SCHEMA');
      const obligation=catalog.obligations[claim.obligation_id];
      if (!obligation) throw new Error('CLAIM_FOR_UNKNOWN_OBLIGATION');
      if (runs.has(claim.run_id)) throw new Error('DUPLICATE_RUN');
      if (record.parent!==claim.claimed_revision) throw new Error('CLAIM_REVISION_MISMATCH');

      lifecycles=deriveLifecycles(catalog,runs,receiptsByRun);
      const current=lifecycles.get(claim.obligation_id);
      if (current?.status!=='UNREALIZED') throw new Error('CLAIM_WHILE_NOT_READY');
      const unsatisfied=dependencyUpstreams(obligation)
        .filter(dependency=>lifecycles.get(dependency)?.status!=='DONE');
      if (unsatisfied.length>0) throw new Error('CLAIM_WITH_UNSATISFIED_DEPENDENCIES');

      const expectedKey=obligationKey(catalog,obligation,lifecycles,receiptsByRun);
      if (!expectedKey) throw new Error('CLAIM_WITH_UNRESOLVED_SEMANTIC_DEPENDENCY');
      if (claim.obligation_key!==expectedKey) throw new Error('CLAIM_OBLIGATION_KEY_MISMATCH');

      const run:HistoricalRun={
        id:claim.run_id,
        obligation_id:claim.obligation_id,
        claimed_revision:claim.claimed_revision,
        claim_commit:record.commit,
        obligation_key:claim.obligation_key,
        obligation:structuredClone(obligation),
        definition_commit:catalog.definition_commits[claim.obligation_id],
      };
      runs.set(run.id,run);
      lifecycles=deriveLifecycles(catalog,runs,receiptsByRun);
    }

    if (record.receipt==null) continue;
    const fact=record.receipt as ReceiptFact;
    if (fact.schema!==RECEIPT_SCHEMA) throw new Error('INVALID_RECEIPT_SCHEMA');
    if (!['observation','judgment-required','execution-terminated'].includes(fact.kind)) {
      throw new Error('INVALID_RECEIPT_KIND');
    }
    const run=runs.get(fact.run_id);
    if (!run) throw new Error('RECEIPT_WITHOUT_CLAIM');
    if (run.obligation_id!==fact.obligation_id) throw new Error('RECEIPT_OBLIGATION_MISMATCH');
    if (fact.claimed_revision!==run.claimed_revision) throw new Error('RECEIPT_REVISION_MISMATCH');
    if (fact.claim_commit!==run.claim_commit) throw new Error('RECEIPT_CLAIM_MISMATCH');

    lifecycles=deriveLifecycles(catalog,runs,receiptsByRun);
    const current=lifecycles.get(run.obligation_id);
    if (current?.run?.id!==run.id) throw new Error('RECEIPT_FOR_NONCURRENT_RUN');
    if (fact.kind==='judgment-required' && current.status!=='EXECUTING') {
      throw new Error('JUDGMENT_REQUIRED_WHILE_NOT_EXECUTING');
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
    if (previous && ['DONE','ABSENT'].includes(previous.disposition)) {
      throw new Error('RECEIPT_AFTER_TERMINAL_SETTLEMENT');
    }

    const receipt=projectReceipt(fact,run.obligation,record.commit);
    receiptsByRun.set(run.id,receipt);
    receipts.push(receipt);
    lifecycles=deriveLifecycles(catalog,runs,receiptsByRun);
  }

  lifecycles=deriveLifecycles(catalog,runs,receiptsByRun);
  return {
    catalog,
    history:{lifecycles,runs,receiptsByRun,receipts},
  };
}
