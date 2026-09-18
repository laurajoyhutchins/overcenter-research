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
type Observation = Extract<ProjectFact, { type: 'effect-observed' }>;
type SettlementDisposition = 'verified' | 'replayable' | 'requires-recovery';

type RunState = {
  claim: Claim;
  terminated: boolean;
  observations: Map<string, Observation>;
  settlement?: {
    observation_id: string;
    disposition: SettlementDisposition;
  };
};

type ObligationState = {
  definition: Definition;
  runs: RunState[];
};

function dispositionFor(
  definition: Definition,
  observation: Observation,
): SettlementDisposition {
  if (
    observation.mutation_certainty === 'present'
    && observation.actual_sha256 === definition.postcondition.content_sha256
  ) {
    return 'verified';
  }
  if (observation.mutation_certainty === 'absent') return 'replayable';
  return 'requires-recovery';
}

function latestRun(obligation: ObligationState): RunState | undefined {
  return obligation.runs.at(-1);
}

function isSatisfied(obligation: ObligationState | undefined): boolean {
  return latestRun(obligation)?.settlement?.disposition === 'verified';
}

export function deriveProjectProjection(
  facts: readonly ProjectFact[],
  authorityRevision: string,
): ProjectProjection {
  if (!authorityRevision) throw new Error('AUTHORITY_REVISION_REQUIRED');

  const obligations = new Map<string, ObligationState>();
  const runs = new Map<string, RunState>();

  for (const fact of facts) {
    switch (fact.type) {
      case 'obligation-defined': {
        if (obligations.has(fact.obligation_id)) {
          throw new Error(`DUPLICATE_OBLIGATION:${fact.obligation_id}`);
        }
        obligations.set(fact.obligation_id, {
          definition: fact,
          runs: [],
        });
        break;
      }

      case 'run-claimed': {
        const obligation = obligations.get(fact.obligation_id);
        if (!obligation) {
          throw new Error(`CLAIM_BEFORE_DEFINITION:${fact.obligation_id}`);
        }
        if (!fact.based_on_revision) {
          throw new Error(`CLAIM_WITHOUT_REVISION:${fact.run_id}`);
        }
        if (runs.has(fact.run_id)) {
          throw new Error(`DUPLICATE_RUN:${fact.run_id}`);
        }

        const previous = latestRun(obligation);
        if (previous && !previous.settlement) {
          throw new Error(`CLAIM_WHILE_ACTIVE:${fact.obligation_id}`);
        }
        if (previous?.settlement?.disposition === 'verified') {
          throw new Error(`CLAIM_AFTER_VERIFIED:${fact.obligation_id}`);
        }
        if (previous?.settlement?.disposition === 'requires-recovery') {
          throw new Error(`CLAIM_DURING_RECOVERY:${fact.obligation_id}`);
        }

        const unsatisfied = obligation.definition.deps.filter(
          dep => !isSatisfied(obligations.get(dep)),
        );
        if (unsatisfied.length > 0) {
          throw new Error(
            `CLAIM_WITH_UNSATISFIED_DEPENDENCIES:${fact.obligation_id}:${unsatisfied.join(',')}`,
          );
        }

        const run: RunState = {
          claim: fact,
          terminated: false,
          observations: new Map(),
        };
        obligation.runs.push(run);
        runs.set(fact.run_id, run);
        break;
      }

      case 'worker-terminated': {
        const run = runs.get(fact.run_id);
        if (!run) {
          throw new Error(`TERMINATION_WITHOUT_CLAIM:${fact.run_id}`);
        }
        if (run.settlement) {
          throw new Error(`TERMINATION_AFTER_SETTLEMENT:${fact.run_id}`);
        }
        if (run.terminated) {
          throw new Error(`DUPLICATE_TERMINATION:${fact.run_id}`);
        }
        run.terminated = true;
        break;
      }

      case 'effect-observed': {
        const run = runs.get(fact.run_id);
        if (!run) {
          throw new Error(`OBSERVATION_WITHOUT_CLAIM:${fact.run_id}`);
        }
        if (run.settlement) {
          throw new Error(`OBSERVATION_AFTER_SETTLEMENT:${fact.run_id}`);
        }
        if (run.observations.has(fact.observation_id)) {
          throw new Error(
            `DUPLICATE_OBSERVATION:${fact.run_id}:${fact.observation_id}`,
          );
        }
        run.observations.set(fact.observation_id, fact);
        break;
      }

      case 'run-settled': {
        const run = runs.get(fact.run_id);
        if (!run) {
          throw new Error(`SETTLEMENT_WITHOUT_CLAIM:${fact.run_id}`);
        }
        if (run.settlement) {
          throw new Error(`DUPLICATE_SETTLEMENT:${fact.run_id}`);
        }
        const observation = run.observations.get(fact.observation_id);
        if (!observation) {
          throw new Error(`SETTLEMENT_WITHOUT_OBSERVATION:${fact.run_id}`);
        }
        const obligation = obligations.get(run.claim.obligation_id)!;
        run.settlement = {
          observation_id: fact.observation_id,
          disposition: dispositionFor(obligation.definition, observation),
        };
        break;
      }
    }
  }

  for (const obligation of obligations.values()) {
    for (const dep of obligation.definition.deps) {
      if (!obligations.has(dep)) {
        throw new Error(
          `UNKNOWN_DEPENDENCY:${obligation.definition.obligation_id}:${dep}`,
        );
      }
    }
  }

  const work = [...obligations.values()]
    .sort((a, b) =>
      a.definition.obligation_id.localeCompare(b.definition.obligation_id),
    )
    .map(({ definition, runs: obligationRuns }): WorkProjection => {
      const run = obligationRuns.at(-1);
      const disposition = run?.settlement?.disposition;

      if (disposition === 'verified') {
        return { id: definition.obligation_id, status: 'DONE' };
      }

      if (run && !run.settlement) {
        return {
          id: definition.obligation_id,
          status: run.terminated ? 'RECOVERY_REQUIRED' : 'EXECUTING',
          active_run_id: run.claim.run_id,
        };
      }

      if (disposition === 'requires-recovery') {
        return {
          id: definition.obligation_id,
          status: 'RECOVERY_REQUIRED',
          active_run_id: run!.claim.run_id,
        };
      }

      const unsatisfied = definition.deps.filter(
        dep => !isSatisfied(obligations.get(dep)),
      );
      if (unsatisfied.length > 0) {
        return {
          id: definition.obligation_id,
          status: 'BLOCKED',
          blocked_reason: `DEPENDENCIES_NOT_DONE:${unsatisfied.join(',')}`,
        };
      }

      return { id: definition.obligation_id, status: 'READY' };
    });

  return { authority_revision: authorityRevision, work };
}

export function canonicalProjection(projection: ProjectProjection): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}
