import type { Obligation } from './model.ts';
import type { ObligationInput, State } from './facts.ts';
import {
  normalizeObligation,
  obligationDefinition,
  obligationDefinitionId,
} from './facts.ts';

export interface GraphReconciliationPlan {
  upsert:Obligation[];
  added:string[];
  rebound:string[];
  unchanged:string[];
}

export function planGraphReconciliation(
  state:State,
  desired:ObligationInput[],
):GraphReconciliationPlan {
  const normalized=desired
    .map(normalizeObligation)
    .sort((a,b)=>a.id.localeCompare(b.id));

  const seen=new Set<string>();
  const upsert:Obligation[]=[];
  const added:string[]=[];
  const rebound:string[]=[];
  const unchanged:string[]=[];

  for (const obligation of normalized) {
    if (seen.has(obligation.id)) {
      throw new Error(`DUPLICATE_DESIRED_OBLIGATION:${obligation.id}`);
    }
    seen.add(obligation.id);

    const definitionId=obligationDefinitionId(
      obligationDefinition(obligation),
    );
    const currentDefinitionId=state.definition_ids[obligation.id];

    if (!currentDefinitionId) {
      upsert.push(obligation);
      added.push(obligation.id);
      continue;
    }
    if (currentDefinitionId===definitionId) {
      unchanged.push(obligation.id);
      continue;
    }
    upsert.push(obligation);
    rebound.push(obligation.id);
  }

  return {upsert,added,rebound,unchanged};
}
