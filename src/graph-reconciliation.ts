import type { Obligation } from './model.ts';
import type { ObligationInput, State } from './facts.ts';
import { normalizeObligation } from './facts.ts';
import { canonicalDigest } from './digest.ts';

export interface GraphReconciliationPlan {
  add:Obligation[];
  replace:Obligation[];
  unchanged:string[];
}

function definitionDigest(obligation:Obligation):string {
  const dependencies=[...obligation.dependencies]
    .sort((a,b)=>canonicalDigest(a).localeCompare(canonicalDigest(b)));
  return canonicalDigest({
    ...obligation,
    dependencies,
  });
}

export function planGraphReconciliation(
  state:State,
  desired:ObligationInput[],
):GraphReconciliationPlan {
  const normalized=desired
    .map(normalizeObligation)
    .sort((a,b)=>a.id.localeCompare(b.id));

  const seen=new Set<string>();
  const add:Obligation[]=[];
  const replace:Obligation[]=[];
  const unchanged:string[]=[];

  for (const obligation of normalized) {
    if (seen.has(obligation.id)) {
      throw new Error(`DUPLICATE_DESIRED_OBLIGATION:${obligation.id}`);
    }
    seen.add(obligation.id);

    const current=state.obligations[obligation.id];
    if (!current) {
      add.push(obligation);
      continue;
    }
    if (definitionDigest(current)===definitionDigest(obligation)) {
      unchanged.push(obligation.id);
      continue;
    }
    replace.push(obligation);
  }

  return {add,replace,unchanged};
}
