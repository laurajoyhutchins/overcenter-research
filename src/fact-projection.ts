export type Postcondition = {
  verifier: 'file-content-equals/v1';
  path: string;
  content_sha256: string;
};

export type ProjectFact =
  | {
      type: 'obligation-defined';
      obligation_id: string;
      deps: string[];
      postcondition: Postcondition;
    }
  | {
      type: 'run-claimed';
      obligation_id: string;
      run_id: string;
      based_on_revision: string;
    }
  | {
      type: 'worker-terminated';
      run_id: string;
      reason: string;
    }
  | {
      type: 'effect-observed';
      run_id: string;
      observation_id: string;
      verifier: Postcondition['verifier'];
      mutation_certainty: 'present' | 'absent' | 'uncertain';
      actual_sha256?: string;
    }
  | {
      type: 'run-settled';
      run_id: string;
      observation_id: string;
      result: 'verified' | 'replayable' | 'requires-recovery';
    };

export type ProjectionStatus =
  | 'READY'
  | 'EXECUTING'
  | 'BLOCKED'
  | 'RECOVERY_REQUIRED'
  | 'DONE';

export interface WorkProjection {
  id: string;
  status: ProjectionStatus;
  active_run_id?: string;
  blocked_reason?: string;
}

export interface ProjectProjection {
  authority_revision: string;
  work: WorkProjection[];
}

type Definition = Extract<ProjectFact, { type: 'obligation-defined' }>;
type Claim = Extract<ProjectFact, { type: 'run-claimed' }>;
type Settlement = Extract<ProjectFact, { type: 'run-settled' }>;

type RunState = {
  claim: Claim;
  terminated: boolean;
  settlement?: Settlement;
};

export function deriveProjectProjection(
  facts: readonly ProjectFact[],
  authorityRevision: string,
): ProjectProjection {
  if (!authorityRevision) throw new Error('AUTHORITY_REVISION_REQUIRED');

  const definitions = new Map<string, Definition>();
  const runs = new Map<string, RunState>();
  const claimsByObligation = new Map<string, Claim[]>();
  const observations = new Map<string, Set<string>>();

  for (const fact of facts) {
    switch (fact.type) {
      case 'obligation-defined': {
        if (definitions.has(fact.obligation_id)) {
          throw new Error(`DUPLICATE_OBLIGATION:${fact.obligation_id}`);
        }
        definitions.set(fact.obligation_id, fact);
        break;
      }
      case 'run-claimed': {
        if (!definitions.has(fact.obligation_id)) {
          throw new Error(`CLAIM_BEFORE_DEFINITION:${fact.obligation_id}`);
        }
        if (runs.has(fact.run_id)) throw new Error(`DUPLICATE_RUN:${fact.run_id}`);
        runs.set(fact.run_id, { claim: fact, terminated: false });
        const claims = claimsByObligation.get(fact.obligation_id) ?? [];
        claims.push(fact);
        claimsByObligation.set(fact.obligation_id, claims);
        break;
      }
      case 'worker-terminated': {
        const run = runs.get(fact.run_id);
        if (!run) throw new Error(`TERMINATION_WITHOUT_CLAIM:${fact.run_id}`);
        run.terminated = true;
        break;
      }
      case 'effect-observed': {
        if (!runs.has(fact.run_id)) {
          throw new Error(`OBSERVATION_WITHOUT_CLAIM:${fact.run_id}`);
        }
        const ids = observations.get(fact.run_id) ?? new Set<string>();
        if (ids.has(fact.observation_id)) {
          throw new Error(`DUPLICATE_OBSERVATION:${fact.run_id}:${fact.observation_id}`);
        }
        ids.add(fact.observation_id);
        observations.set(fact.run_id, ids);
        break;
      }
      case 'run-settled': {
        const run = runs.get(fact.run_id);
        if (!run) throw new Error(`SETTLEMENT_WITHOUT_CLAIM:${fact.run_id}`);
        if (run.settlement) throw new Error(`DUPLICATE_SETTLEMENT:${fact.run_id}`);
        if (!observations.get(fact.run_id)?.has(fact.observation_id)) {
          throw new Error(`SETTLEMENT_WITHOUT_OBSERVATION:${fact.run_id}`);
        }
        const observation = facts
          .slice(0, facts.indexOf(fact))
          .find(candidate =>
            candidate.type === 'effect-observed'
            && candidate.run_id === fact.run_id
            && candidate.observation_id === fact.observation_id,
          );
        if (!observation || observation.type !== 'effect-observed') {
          throw new Error(`SETTLEMENT_WITHOUT_OBSERVATION:${fact.run_id}`);
        }
        if (fact.result === 'verified') {
          const definition = definitions.get(run.claim.obligation_id);
          if (!definition) {
            throw new Error(`SETTLEMENT_WITHOUT_DEFINITION:${fact.run_id}`);
          }
          const verifies =
            observation.mutation_certainty === 'present'
            && typeof observation.actual_sha256 === 'string'
            && observation.actual_sha256 === definition.postcondition.content_sha256;
          if (!verifies) {
            throw new Error(`INVALID_VERIFIED_SETTLEMENT:${fact.run_id}`);
          }
        }
        run.settlement = fact;
        break;
      }
    }
  }

  for (const definition of definitions.values()) {
    for (const dep of definition.deps) {
      if (!definitions.has(dep)) {
        throw new Error(`UNKNOWN_DEPENDENCY:${definition.obligation_id}:${dep}`);
      }
    }
  }

  const projected = new Map<string, WorkProjection>();
  const ids = [...definitions.keys()].sort((a, b) => a.localeCompare(b));

  const latestSettlement = (id: string): Settlement | null => {
    const claims = claimsByObligation.get(id) ?? [];
    for (let index = claims.length - 1; index >= 0; index -= 1) {
      const settlement = runs.get(claims[index].run_id)?.settlement;
      if (settlement) return settlement;
      if (index === claims.length - 1) return null;
    }
    return null;
  };

  const satisfied = (id: string) => latestSettlement(id)?.result === 'verified';

  for (const id of ids) {
    const definition = definitions.get(id)!;
    const claims = claimsByObligation.get(id) ?? [];
    const latestClaim = claims.at(-1);
    const latestRun = latestClaim ? runs.get(latestClaim.run_id)! : undefined;
    const settlement = latestSettlement(id);

    if (settlement?.result === 'verified') {
      projected.set(id, { id, status: 'DONE' });
      continue;
    }

    if (latestRun && !latestRun.settlement) {
      projected.set(id, {
        id,
        status: latestRun.terminated ? 'RECOVERY_REQUIRED' : 'EXECUTING',
        active_run_id: latestRun.claim.run_id,
      });
      continue;
    }

    if (latestRun?.settlement?.result === 'requires-recovery') {
      projected.set(id, {
        id,
        status: 'RECOVERY_REQUIRED',
        active_run_id: latestRun.claim.run_id,
      });
      continue;
    }

    const unsatisfied = definition.deps.filter(dep => !satisfied(dep));
    if (unsatisfied.length > 0) {
      projected.set(id, {
        id,
        status: 'BLOCKED',
        blocked_reason: `DEPENDENCIES_NOT_DONE:${unsatisfied.join(',')}`,
      });
      continue;
    }

    projected.set(id, { id, status: 'READY' });
  }

  return {
    authority_revision: authorityRevision,
    work: ids.map(id => projected.get(id)!),
  };
}

export function canonicalProjection(projection: ProjectProjection): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}
