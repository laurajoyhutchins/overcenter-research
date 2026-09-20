export type LifecycleStatus = 'READY' | 'EXECUTING' | 'WAITING' | 'RECOVERY_REQUIRED' | 'DONE';
export type WorkStatus = LifecycleStatus | 'BLOCKED';
export type Disposition = 'DONE' | 'READY' | 'WAITING' | 'RECOVERY_REQUIRED';
export type MutationCertainty = 'present' | 'absent' | 'uncertain';
export type Data = Record<string, unknown>;

export interface AbsenceEvidenceCertificate extends Data {
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

export interface GitHubCommitStatusEffectAuthority {
  contract: 'github-commit-status/set-from-postcondition/v1';
  adapter_contract_digest: string;
}

export type EffectAuthority = GitHubCommitStatusEffectAuthority;

export interface CanonicalResultAcceptance {
  verifier: 'canonical-json-sha256/v1';
  expected_sha256: string;
}

export type ResultAcceptance = CanonicalResultAcceptance;

export interface WorkerResultEnvelope extends Data {
  schema: 'overcenter-worker-result-v1';
  session: TaskSession;
  result: Data;
}

export interface TaskSession {
  schema: 'overcenter-task-session-v2';
  run_id: string;
  obligation_id: string;
  claimed_revision: string;
  execution_generation: number;
  execution_authority_commit: string;
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
  effect_authority?: EffectAuthority;
  result_acceptance?: ResultAcceptance;
}

export interface Work extends Obligation {
  status: WorkStatus;
  revision: string;
  run_id?: string;
  claimed_revision?: string;
  execution_generation?: number;
  execution_authority_commit?: string;
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
