import type { DelegationReservation, HistoricalRun, State } from './facts.ts';
import { dependencyUpstreams } from '../graph/topology.ts';

export interface DelegationCycleInput {
  state: State;
  runs: ReadonlyMap<string, HistoricalRun>;
  unresolvedDelegationsByRun: ReadonlyMap<
    string,
    ReadonlyMap<string, DelegationReservation>
  >;
  parentObligationId: string;
  childObligationId: string;
}

export function delegationCreatesCausalCycle({
  state,
  runs,
  unresolvedDelegationsByRun,
  parentObligationId,
  childObligationId,
}: DelegationCycleInput): boolean {
  const delegatedChildren = new Map<string, string[]>();
  for (const [runId, delegations] of unresolvedDelegationsByRun) {
    const run = runs.get(runId);
    if (!run) throw new Error('DELEGATION_PARENT_RUN_MISSING');
    const children = delegatedChildren.get(run.obligation_id) ?? [];
    for (const delegation of delegations.values()) {
      children.push(delegation.child_obligation_id);
    }
    delegatedChildren.set(run.obligation_id, children);
  }

  const seen = new Set<string>();
  const pending = [childObligationId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === parentObligationId) return true;
    if (seen.has(current)) continue;
    seen.add(current);

    const obligation = state.obligations[current];
    if (obligation) {
      pending.push(...dependencyUpstreams(obligation));
    }
    pending.push(...(delegatedChildren.get(current) ?? []));
  }
  return false;
}
