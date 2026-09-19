export type LifecycleStatus = 'READY' | 'EXECUTING' | 'WAITING' | 'RECOVERY_REQUIRED' | 'DONE';
export type WorkStatus = LifecycleStatus | 'BLOCKED';
export type Disposition = 'DONE' | 'READY' | 'WAITING' | 'RECOVERY_REQUIRED';
export type MutationCertainty = 'present' | 'absent' | 'uncertain';
export type Data = Record<string, unknown>;

export interface AbsenceEvidenceCertificate {
  schema: 'overcenter-absence-evidence-v1';
  kind: string;
  subject: Data;
  scope: Data;
  snapshot: Data | null;
  completeness: Data;
  provenance: Data;
}

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

export interface GitHubCommitStatusPostconditionV1 {
  verifier: 'github-commit-status/v1';
  provider: 'github';
  repository_id: number;
  commit_sha: string;
  context: string;
  expected_state: 'error' | 'failure' | 'pending' | 'success';
}

export interface GitHubCommitStatusPostconditionV2 {
  verifier: 'github-commit-status/v2';
  provider: 'github';
  repository_id: number;
  repository_full_name: string;
  commit_sha: string;
  context: string;
  expected_state: 'error' | 'failure' | 'pending' | 'success';
}

export type GitHubCommitStatusPostcondition =
  | GitHubCommitStatusPostconditionV1
  | GitHubCommitStatusPostconditionV2;

export interface KubernetesConfigMapExistsPostcondition {
  verifier: 'kubernetes-configmap-exists/v1';
  provider: 'kubernetes';
  authority_id: string;
  api_group: '';
  resource: 'configmaps';
  namespace: string;
  name: string;
}

export type Postcondition =
  | FileContentPostcondition
  | EventuallyConsistentFilePostcondition
  | GitHubCommitStatusPostcondition
  | KubernetesConfigMapExistsPostcondition;

export interface Observation {
  verifier: Postcondition['verifier'];
  mutation_certainty: MutationCertainty;
  absence_evidence?: AbsenceEvidenceCertificate;
  path?: string;
  expected_sha256?: string;
  actual_sha256?: string;
  provider?: 'github' | 'kubernetes';
  authority_id?: string;
  api_group?: string;
  resource?: string;
  namespace?: string;
  name?: string;
  observed_uid?: string;
  observed_resource_version?: string;
  snapshot_resource_version?: string;
  repository_id?: number;
  repository_full_name?: string;
  commit_sha?: string;
  context?: string;
  expected_state?: string;
  actual_state?: string;
  observation_error?: string;
  provider_evidence?: Data;
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
  execution_generation?: number;
  blocked_reason?: string;
}

export interface Run {
  id: string;
  obligation_id: string;
  claimed_revision: string;
  claim_commit: string;
  obligation_key: string;
  execution_generation: number;
  execution_authority_commit: string;
  execution_capability_sha256: string;
}

export interface ExecutionPermit extends Run {
  execution_capability: string;
}

export interface ExecuteOutcome extends Data {
  kind?: string;
  may_have_mutated?: boolean;
}

export interface PreflightOutcome extends Data {
  kind: 'execute' | 'judgment-required';
}

export interface LoopOptions {
  preflight?: (packet: Data) => Promise<PreflightOutcome>;
  effect: (packet: Data) => Promise<ExecuteOutcome>;
  maxAdvances?: number;
}

export interface LoopResult {
  state: 'IDLE' | 'BLOCKED' | 'RECOVERY_REQUIRED' | 'WAITING' | 'BUDGET_EXHAUSTED';
  advances: number;
  work?: string;
  run?: string;
}
