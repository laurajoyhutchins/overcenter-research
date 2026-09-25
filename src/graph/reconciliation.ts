import type { Obligation } from '../model.ts';
import type { ObligationInput, State } from '../authority/facts.ts';
import {
  normalizeObligation,
  obligationDefinition,
  obligationDefinitionId,
} from '../authority/facts.ts';

export interface GraphReconciliationPlan {
  upsert: Obligation[];
  retire: string[];
  added: string[];
  rebound: string[];
  unchanged: string[];
}

export function planGraphReconciliation(
  state: State,
  desired: ObligationInput[],
  managedPrefixes: readonly string[] = [],
): GraphReconciliationPlan {
  const normalized = desired.map(normalizeObligation).sort((a, b) => a.id.localeCompare(b.id));

  const seen = new Set<string>();
  const upsert: Obligation[] = [];
  const added: string[] = [];
  const rebound: string[] = [];
  const unchanged: string[] = [];

  for (const prefix of managedPrefixes) {
    if (prefix.length === 0) throw new Error('MANAGED_OBLIGATION_PREFIX_EMPTY');
  }

  for (const obligation of normalized) {
    if (seen.has(obligation.id)) {
      throw new Error(`DUPLICATE_DESIRED_OBLIGATION:${obligation.id}`);
    }
    seen.add(obligation.id);

    const definitionId = obligationDefinitionId(obligationDefinition(obligation));
    const currentDefinitionId = state.definition_ids[obligation.id];

    if (!currentDefinitionId) {
      upsert.push(obligation);
      added.push(obligation.id);
      continue;
    }
    if (currentDefinitionId === definitionId) {
      unchanged.push(obligation.id);
      continue;
    }
    upsert.push(obligation);
    rebound.push(obligation.id);
  }

  const desiredIds = new Set(normalized.map((obligation) => obligation.id));
  const retire = Object.keys(state.obligations)
    .filter((id) => managedPrefixes.some((prefix) => id.startsWith(prefix)) && !desiredIds.has(id))
    .sort();

  return { upsert, retire, added, rebound, unchanged };
}
