import { sha256 } from '../../digest.ts';
import { GitFactStore } from '../../storage/git-store.ts';
import { observeCertifiedGithubRepository } from './certified-repository.ts';
import { GITHUB_API_VERSION } from './contract.ts';
import { githubGetAsync, runGithubReadObserverAsync, type GithubJsonGetAsync } from './rest.ts';

const STATE_SCHEMA = 'overcenter-github-actions-runner-backend/v1' as const;
const STATE_FILE = 'github-actions-runners.json';
const DEFAULT_REF = 'refs/overcenter/github-actions-runners';

interface RunnerConnectionIdentity {
  lease_id: string;
  repository_id: number;
  repository_full_name: string;
  runner_name: string;
  runner_group_id: number;
  labels: string[];
  work_folder: '_work';
}

export interface GithubActionsRunnerDispatchingState extends RunnerConnectionIdentity {
  phase: 'dispatching';
}

export interface GithubActionsRunnerRegisteredState extends RunnerConnectionIdentity {
  phase: 'registered';
  runner_id: number;
  encoded_jit_config_sha256: string;
}

export type GithubActionsRunnerConnectionState =
  | GithubActionsRunnerDispatchingState
  | GithubActionsRunnerRegisteredState;

interface RunnerState {
  schema: typeof STATE_SCHEMA;
  registrations: GithubActionsRunnerConnectionState[];
}

export interface GithubActionsRunnerStateStore {
  head(): string | null;
  read(head: string): unknown | null;
  append(expectedHead: string | null, state: RunnerState): string | null;
}

class GitRunnerStateStore implements GithubActionsRunnerStateStore {
  readonly #store: GitFactStore;

  constructor(
    repo: string,
    {
      ref = DEFAULT_REF,
      remote = 'origin',
    }: {
      ref?: string;
      remote?: string | null;
    } = {},
  ) {
    this.#store = new GitFactStore(repo, { ref, remote });
  }

  head(): string | null {
    return this.#store.head();
  }

  read(head: string): unknown | null {
    return this.#store.readJson(head, STATE_FILE);
  }

  append(expectedHead: string | null, state: RunnerState): string | null {
    return this.#store.append(expectedHead, 'overcenter: register GitHub Actions runner', {
      [STATE_FILE]: state,
    });
  }
}

export interface GithubJitRunnerBody {
  name: string;
  runner_group_id: number;
  labels: string[];
  work_folder: '_work';
}

export type GithubJitRunnerPost = (
  token: string,
  path: string,
  body: GithubJitRunnerBody,
) => Promise<{ status: number; body: string }>;

async function githubPostJitRunner(
  token: string,
  path: string,
  body: GithubJitRunnerBody,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

function positiveInteger(value: unknown, code: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(code);
  }
}

function nonemptyString(value: unknown, code: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
}

function validateLeaseId(value: string): void {
  if (
    value.length > 256 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error('GITHUB_ACTIONS_RUNNER_LEASE_ID_INVALID');
  }
}

function normalizeLabels(value: readonly string[]): string[] {
  if (value.length === 0 || value.length > 100) {
    throw new Error('GITHUB_ACTIONS_RUNNER_LABELS_INVALID');
  }
  const normalized = value.map((label) => {
    if (
      label.length === 0 ||
      label.length > 255 ||
      [...label].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    ) {
      throw new Error('GITHUB_ACTIONS_RUNNER_LABELS_INVALID');
    }
    return label;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('GITHUB_ACTIONS_RUNNER_LABELS_DUPLICATE');
  }
  return [...normalized].sort();
}

function validateRegistration(value: unknown): GithubActionsRunnerConnectionState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GITHUB_ACTIONS_RUNNER_STATE_INVALID');
  }
  const raw = value as Record<string, unknown>;
  nonemptyString(raw.lease_id, 'GITHUB_ACTIONS_RUNNER_STATE_INVALID');
  validateLeaseId(raw.lease_id);
  positiveInteger(raw.repository_id, 'GITHUB_ACTIONS_RUNNER_STATE_INVALID');
  nonemptyString(raw.repository_full_name, 'GITHUB_ACTIONS_RUNNER_STATE_INVALID');
  nonemptyString(raw.runner_name, 'GITHUB_ACTIONS_RUNNER_STATE_INVALID');
  positiveInteger(raw.runner_group_id, 'GITHUB_ACTIONS_RUNNER_STATE_INVALID');
  if (!Array.isArray(raw.labels) || !raw.labels.every((label) => typeof label === 'string')) {
    throw new Error('GITHUB_ACTIONS_RUNNER_STATE_INVALID');
  }
  const labels = normalizeLabels(raw.labels);
  if (raw.work_folder !== '_work') throw new Error('GITHUB_ACTIONS_RUNNER_STATE_INVALID');

  const identity: RunnerConnectionIdentity = {
    lease_id: raw.lease_id,
    repository_id: raw.repository_id,
    repository_full_name: raw.repository_full_name,
    runner_name: raw.runner_name,
    runner_group_id: raw.runner_group_id,
    labels,
    work_folder: '_work',
  };

  if (raw.phase === 'dispatching') return { ...identity, phase: 'dispatching' };
  if (raw.phase === 'registered') {
    positiveInteger(raw.runner_id, 'GITHUB_ACTIONS_RUNNER_STATE_INVALID');
    nonemptyString(raw.encoded_jit_config_sha256, 'GITHUB_ACTIONS_RUNNER_STATE_INVALID');
    if (!/^[0-9a-f]{64}$/.test(raw.encoded_jit_config_sha256)) {
      throw new Error('GITHUB_ACTIONS_RUNNER_STATE_INVALID');
    }
    return {
      ...identity,
      phase: 'registered',
      runner_id: raw.runner_id,
      encoded_jit_config_sha256: raw.encoded_jit_config_sha256,
    };
  }
  throw new Error('GITHUB_ACTIONS_RUNNER_STATE_INVALID');
}

function state(value: unknown): RunnerState {
  if (value == null) return { schema: STATE_SCHEMA, registrations: [] };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GITHUB_ACTIONS_RUNNER_STATE_INVALID');
  }
  const raw = value as { schema?: unknown; registrations?: unknown };
  if (raw.schema !== STATE_SCHEMA || !Array.isArray(raw.registrations)) {
    throw new Error('GITHUB_ACTIONS_RUNNER_STATE_INVALID');
  }
  const registrations = raw.registrations.map(validateRegistration);
  const leaseIds = registrations.map((registration) => registration.lease_id);
  if (new Set(leaseIds).size !== leaseIds.length) {
    throw new Error('GITHUB_ACTIONS_RUNNER_STATE_DUPLICATE');
  }
  return { schema: STATE_SCHEMA, registrations };
}

function deterministicRunnerName(leaseId: string): string {
  return `overcenter-${sha256(leaseId).slice(0, 24)}`;
}

function sameIdentity(
  registration: GithubActionsRunnerConnectionState,
  expected: RunnerConnectionIdentity,
): boolean {
  return (
    registration.lease_id === expected.lease_id &&
    registration.repository_id === expected.repository_id &&
    registration.repository_full_name.toLowerCase() ===
      expected.repository_full_name.toLowerCase() &&
    registration.runner_name === expected.runner_name &&
    registration.runner_group_id === expected.runner_group_id &&
    JSON.stringify(registration.labels) === JSON.stringify(expected.labels) &&
    registration.work_folder === expected.work_folder
  );
}

function replayError(registration: GithubActionsRunnerConnectionState): Error {
  return new Error(
    registration.phase === 'registered'
      ? 'GITHUB_ACTIONS_RUNNER_CONFIG_ALREADY_MINTED'
      : 'GITHUB_ACTIONS_RUNNER_REGISTRATION_RECOVERY_REQUIRED',
  );
}

export interface GithubActionsRunnerConnection {
  lease_id: string;
  runner_id: number;
  runner_name: string;
  repository_id: number;
  repository_full_name: string;
  labels: string[];
  encoded_jit_config: string;
  encoded_jit_config_sha256: string;
}

export class GithubActionsRunnerBackend {
  readonly #store: GithubActionsRunnerStateStore;

  constructor(
    repo: string,
    {
      store,
      ref,
      remote,
    }: {
      store?: GithubActionsRunnerStateStore;
      ref?: string;
      remote?: string | null;
    } = {},
  ) {
    this.#store = store ?? new GitRunnerStateStore(repo, { ref, remote });
  }

  connectionState(leaseId: string): GithubActionsRunnerConnectionState | null {
    if (!leaseId) throw new Error('GITHUB_ACTIONS_RUNNER_LEASE_ID_REQUIRED');
    validateLeaseId(leaseId);
    const head = this.#store.head();
    if (!head) return null;
    return (
      state(this.#store.read(head)).registrations.find(
        (registration) => registration.lease_id === leaseId,
      ) ?? null
    );
  }

  async mintJitConnection(
    token: string,
    {
      leaseId,
      repositoryId,
      repositoryFullName,
      runnerGroupId,
      runnerLabels = ['self-hosted', 'overcenter'],
      get = githubGetAsync,
      post = githubPostJitRunner,
      clock = () => new Date().toISOString(),
    }: {
      leaseId: string;
      repositoryId: number;
      repositoryFullName: string;
      runnerGroupId: number;
      runnerLabels?: readonly string[];
      get?: GithubJsonGetAsync;
      post?: GithubJitRunnerPost;
      clock?: () => string;
    },
  ): Promise<GithubActionsRunnerConnection> {
    if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
    if (!leaseId) throw new Error('GITHUB_ACTIONS_RUNNER_LEASE_ID_REQUIRED');
    validateLeaseId(leaseId);
    positiveInteger(repositoryId, 'GITHUB_ACTIONS_RUNNER_REPOSITORY_ID_INVALID');
    positiveInteger(runnerGroupId, 'GITHUB_ACTIONS_RUNNER_GROUP_ID_INVALID');
    const labels = normalizeLabels(runnerLabels);

    const prior = this.connectionState(leaseId);
    if (prior) throw replayError(prior);

    const repository = await runGithubReadObserverAsync(
      token,
      (syncGet) =>
        observeCertifiedGithubRepository(token, {
          repositoryId,
          repositoryFullName,
          get: syncGet,
          clock,
          observerId: 'github-actions-runner-backend/v1',
        }),
      get,
    );
    const canonical = repository.fact.object;
    const expected: RunnerConnectionIdentity = {
      lease_id: leaseId,
      repository_id: repositoryId,
      repository_full_name: canonical.full_name,
      runner_name: deterministicRunnerName(leaseId),
      runner_group_id: runnerGroupId,
      labels,
      work_folder: '_work',
    };

    let dispatchRecorded = false;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#store.head();
      const current = state(head ? this.#store.read(head) : null);
      const existing = current.registrations.find(
        (registration) => registration.lease_id === leaseId,
      );
      if (existing) {
        if (!sameIdentity(existing, expected)) {
          throw new Error('GITHUB_ACTIONS_RUNNER_REGISTRATION_IDENTITY_CONFLICT');
        }
        throw replayError(existing);
      }
      if (
        this.#store.append(head, {
          schema: STATE_SCHEMA,
          registrations: [...current.registrations, { ...expected, phase: 'dispatching' }],
        })
      ) {
        dispatchRecorded = true;
        break;
      }
    }
    if (!dispatchRecorded) {
      throw new Error('GITHUB_ACTIONS_RUNNER_REGISTRATION_CONTENTION_EXHAUSTED');
    }

    const path = `/repos/${encodeURIComponent(canonical.owner)}/${encodeURIComponent(canonical.repo)}/actions/runners/generate-jitconfig`;
    const body: GithubJitRunnerBody = {
      name: expected.runner_name,
      runner_group_id: runnerGroupId,
      labels,
      work_folder: '_work',
    };
    const response = await post(token, path, body);
    if (response.status !== 201) {
      throw new Error(
        `GITHUB_ACTIONS_RUNNER_JIT_CONFIGURATION_FAILED:${response.status}:${response.body}`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(response.body);
    } catch {
      throw new Error('GITHUB_ACTIONS_RUNNER_JIT_CONFIGURATION_INVALID_JSON');
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('GITHUB_ACTIONS_RUNNER_JIT_CONFIGURATION_INVALID');
    }
    const result = raw as {
      runner?: { id?: unknown; name?: unknown };
      encoded_jit_config?: unknown;
    };
    if (!result.runner || result.runner.name !== expected.runner_name) {
      throw new Error('GITHUB_ACTIONS_RUNNER_JIT_CONFIGURATION_RUNNER_MISMATCH');
    }
    positiveInteger(result.runner.id, 'GITHUB_ACTIONS_RUNNER_JIT_CONFIGURATION_INVALID');
    nonemptyString(result.encoded_jit_config, 'GITHUB_ACTIONS_RUNNER_JIT_CONFIGURATION_INVALID');
    const configDigest = sha256(result.encoded_jit_config);

    let registered = false;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const head = this.#store.head();
      if (!head) break;
      const current = state(this.#store.read(head));
      const index = current.registrations.findIndex(
        (registration) => registration.lease_id === leaseId,
      );
      const existing = current.registrations[index];
      if (!existing || existing.phase !== 'dispatching' || !sameIdentity(existing, expected)) {
        throw new Error('GITHUB_ACTIONS_RUNNER_REGISTRATION_AUTHORITY_LOST');
      }
      const next = [...current.registrations];
      next[index] = {
        ...expected,
        phase: 'registered',
        runner_id: result.runner.id,
        encoded_jit_config_sha256: configDigest,
      };
      if (this.#store.append(head, { schema: STATE_SCHEMA, registrations: next })) {
        registered = true;
        break;
      }
    }
    if (!registered) {
      throw new Error('GITHUB_ACTIONS_RUNNER_REGISTRATION_COMMIT_CONTENTION_EXHAUSTED');
    }

    return {
      lease_id: leaseId,
      runner_id: result.runner.id,
      runner_name: expected.runner_name,
      repository_id: repositoryId,
      repository_full_name: canonical.full_name,
      labels,
      encoded_jit_config: result.encoded_jit_config,
      encoded_jit_config_sha256: configDigest,
    };
  }
}
