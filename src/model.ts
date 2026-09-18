export type LifecycleStatus = 'READY' | 'EXECUTING' | 'WAITING' | 'RECOVERY_REQUIRED' | 'DONE';
export type WorkStatus = LifecycleStatus | 'BLOCKED';
export type ReceiptDisposition = 'DONE' | 'ABSENT' | 'WAITING' | 'RECOVERY_REQUIRED';
export type MutationCertainty = 'present' | 'absent' | 'uncertain';
export type Data = Record<string, unknown>;

export interface FileContentPostcondition {
  verifier: 'file-content-equals/v1';
  path: string;
  content: string;
}

export interface EventuallyConsistentFilePostcondition {
  verifier: 'eventually-consistent-file-content-equals/v1';
  path: string;
  content: string;
}

export interface GitHubCommitStatusPostcondition {
  verifier: 'github-commit-status/v1';
  provider: 'github';
  repository_id: number;
  commit_sha: string;
  context: string;
  expected_state: 'error' | 'failure' | 'pending' | 'success';
}

export type Postcondition =
  | FileContentPostcondition
  | EventuallyConsistentFilePostcondition
  | GitHubCommitStatusPostcondition;

export interface Observation extends Data {
  verifier: Postcondition['verifier'];
  mutation_certainty: MutationCertainty;
  path?: string;
  expected_sha256?: string;
  actual_sha256?: string;
  provider?: 'github';
  repository_id?: number;
  repository_full_name?: string;
  commit_sha?: string;
  context?: string;
  expected_state?: string;
  actual_state?: string;
}

export type Dependency =
  | { kind: 'control'; upstream: string }
  | {
      kind: 'semantic';
      upstream: string;
      consumes:
        | { kind: 'output'; selector: string }
        | { kind: 'evidence'; selector: string };
    };

export interface Obligation {
  id: string;
  dependencies: Dependency[];
  packet: Data;
  postcondition: Postcondition;
}

export interface Work extends Obligation {
  status: WorkStatus;
  revision: string;
  run_id?: string;
  claimed_revision?: string;
  blocked_reason?: string;
}

export interface Run {
  id: string;
  obligation_id: string;
  claimed_revision: string;
  claim_commit: string;
  obligation_key: string;
}

export interface ExecuteOutcome extends Data {
  kind?: string;
  may_have_mutated?: boolean;
}

export interface LoopOptions {
  execute: (packet: Data, run: Run) => Promise<ExecuteOutcome>;
  maxAdvances?: number;
}

export interface LoopResult {
  state: 'IDLE' | 'BLOCKED' | 'RECOVERY_REQUIRED' | 'WAITING' | 'BUDGET_EXHAUSTED';
  advances: number;
  work?: string;
  run?: string;
}
