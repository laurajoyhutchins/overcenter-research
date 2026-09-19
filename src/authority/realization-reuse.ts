import type {
  Observation,
  Postcondition,
} from '../model.ts';
import type {
  HistoricalRun,
  Receipt,
  State,
} from './facts.ts';
import {
  authoritativeAbsenceEvidence,
  observationVerified,
} from '../observation/observe.ts';

export type CurrentRealizationJudgment =
  | {
      state:'admissible';
      reason:'CURRENT_POSTCONDITION_VERIFIED';
    }
  | {
      state:'rejected';
      reason:
        | 'CURRENT_POSTCONDITION_NOT_VERIFIED'
        | 'CURRENT_REALIZATION_AUTHORITATIVELY_ABSENT';
    }
  | {
      state:'indeterminate';
      reason:string;
    };

export function classifyCurrentRealization(
  postcondition:Postcondition,
  observed:Observation,
):CurrentRealizationJudgment {
  try {
    if (observationVerified(postcondition,observed)) {
      return {
        state:'admissible',
        reason:'CURRENT_POSTCONDITION_VERIFIED',
      };
    }

    if (observed.mutation_certainty==='present') {
      return {
        state:'rejected',
        reason:'CURRENT_POSTCONDITION_NOT_VERIFIED',
      };
    }

    if (
      observed.mutation_certainty==='absent'
      && authoritativeAbsenceEvidence(postcondition,observed)
    ) {
      return {
        state:'rejected',
        reason:'CURRENT_REALIZATION_AUTHORITATIVELY_ABSENT',
      };
    }

    return {
      state:'indeterminate',
      reason:typeof observed.observation_error==='string'
        ? observed.observation_error
        : 'CURRENT_REALIZATION_OBSERVATION_INDETERMINATE',
    };
  } catch (error:unknown) {
    return {
      state:'indeterminate',
      reason:error instanceof Error
        ? error.message
        : 'CURRENT_REALIZATION_EVIDENCE_INVALID',
    };
  }
}

export function deriveCurrentRealizationJudgments({
  state,
  runs,
  receiptsByRun,
  semanticKeys,
  observe,
}:{
  state:State;
  runs:Map<string,HistoricalRun>;
  receiptsByRun:Map<string,Receipt>;
  semanticKeys:Map<string,string|null>;
  observe:(postcondition:Postcondition)=>Observation;
}):Map<string,CurrentRealizationJudgment> {
  const judgments=new Map<string,CurrentRealizationJudgment>();

  for (const obligation of Object.values(state.obligations)) {
    const semanticKey=semanticKeys.get(obligation.id)??null;
    if (!semanticKey) continue;

    const candidates=[...runs.values()].filter(run=>
      run.obligation_id===obligation.id
      && run.obligation_key===semanticKey
      && receiptsByRun.get(run.id)?.disposition==='DONE'
    );
    if (candidates.length===0) continue;

    let judgment:CurrentRealizationJudgment;
    try {
      judgment=classifyCurrentRealization(
        obligation.postcondition,
        observe(obligation.postcondition),
      );
    } catch (error:unknown) {
      judgment={
        state:'indeterminate',
        reason:error instanceof Error
          ? error.message
          : 'CURRENT_REALIZATION_OBSERVATION_FAILED',
      };
    }

    for (const run of candidates) judgments.set(run.id,judgment);
  }

  return judgments;
}
