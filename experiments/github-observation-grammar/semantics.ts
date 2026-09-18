import type { RawObservation } from './openapi.ts';
import {
  evaluateMutableEntity,
  evaluatePositiveCollectionMember,
  paginationShape,
  sameEntityIdentity,
} from './semantic-shapes.ts';

export interface FactEvidence {
  api_version: string;
  operation_id: string;
  schema_sha256: string;
  observed_at: string;
  observer: { kind: string; id: string };
  provider_date: string | null;
  etag: string | null;
  request_id: string | null;
}

export interface RepositoryIdentityFact {
  kind: 'repository-identity';
  subject: {
    kind: 'github.repository';
    id: number;
    node_id: string;
  };
  relation: 'named';
  object: {
    owner: string;
    repo: string;
    full_name: string;
  };
  stability: 'stable-subject-mutable-alias';
  evidence: FactEvidence;
}

export interface GitRefTargetFact {
  kind: 'binding';
  subject: {
    kind: 'github.ref';
    repository_id: number;
    ref: string;
  };
  relation: 'targets';
  object: {
    kind: 'github.commit' | 'github.tag';
    sha: string;
  };
  stability: 'mutable-snapshot';
  evidence: FactEvidence;
}

export interface GitCommitFact {
  kind: 'immutable-object';
  subject: {
    kind: 'github.commit';
    repository_id: number;
    sha: string;
  };
  tree_sha: string;
  parent_shas: string[];
  stability: 'content-addressed';
  evidence: FactEvidence;
}

export interface PullRequestSnapshotFact {
  kind: 'entity-snapshot';
  subject: {
    kind: 'github.pull-request';
    repository_id: number;
    number: number;
    id: number;
    node_id: string;
  };
  state: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
  stability: 'mutable-snapshot';
  evidence: FactEvidence;
}

export interface IssueSnapshotFact {
  kind: 'entity-snapshot';
  subject: {
    kind: 'github.issue';
    repository_id: number;
    number: number;
    id: number;
    node_id: string;
  };
  state: string;
  title: string;
  locked: boolean;
  is_pull_request: boolean;
  stability: 'mutable-snapshot';
  evidence: FactEvidence;
}

export interface CheckRunMember {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
}

export interface CheckRunsPageFact {
  kind: 'collection-page';
  subject: {
    kind: 'github.check-runs';
    repository_id: number;
    ref: string;
  };
  members: CheckRunMember[];
  total_count: number;
  page: number;
  per_page: number;
  has_next: boolean;
  enumeration: 'partial' | 'terminal-page-seen';
  negative_evidence_authoritative: false;
  evidence: FactEvidence;
}

export interface CommitStatusMember {
  id: number;
  node_id: string;
  state: string;
  context: string;
  target_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommitStatusesPageFact {
  kind: 'collection-page';
  subject: {
    kind: 'github.commit-statuses';
    repository_id: number;
    ref: string;
  };
  members: CommitStatusMember[];
  page: number;
  per_page: number;
  has_next: boolean;
  enumeration: 'partial' | 'terminal-page-seen';
  negative_evidence_authoritative: false;
  evidence: FactEvidence;
}

export type GithubFact =
  | RepositoryIdentityFact
  | GitRefTargetFact
  | GitCommitFact
  | PullRequestSnapshotFact
  | IssueSnapshotFact
  | CheckRunsPageFact
  | CommitStatusesPageFact;

export interface GitRefTargetObligation {
  repository_id: number;
  ref: string;
  target_sha: string;
}

export interface PullRequestObligation {
  repository_id: number;
  number: number;
  state?: string;
  head_sha?: string;
  base_ref?: string;
}

export interface IssueObligation {
  repository_id: number;
  number: number;
  state?: string;
  title?: string;
  locked?: boolean;
}

export interface CheckRunObligation {
  repository_id: number;
  ref: string;
  id?: number;
  name?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
}

export interface CommitStatusObligation {
  repository_id: number;
  ref: string;
  id?: number;
  node_id?: string;
  context?: string;
  state?: string;
}

export interface ObligationEvaluation<T extends GithubFact = GithubFact> {
  state: 'SATISFIED' | 'UNSATISFIED' | 'INDETERMINATE';
  reason: string;
  fact?: T;
}

export interface RevalidatedObservation extends RawObservation {
  revalidated_from: {
    observed_at: string;
    etag: string;
  };
}

const sha = /^[0-9a-f]{40,64}$/i;
const canonicalRef = (ref: string) => ref.startsWith('refs/') ? ref : `refs/${ref}`;
const lower = (value: string) => value.toLowerCase();

function evidence(observation: RawObservation): FactEvidence {
  return {
    api_version: observation.contract.api_version,
    operation_id: observation.contract.operation_id,
    schema_sha256: observation.contract.schema_sha256,
    observed_at: observation.observed_at,
    observer: structuredClone(observation.observer),
    provider_date: observation.response.date,
    etag: observation.response.etag,
    request_id: observation.response.request_id,
  };
}

function observed200(observation: RawObservation, operationId: string): boolean {
  return observation.contract.operation_id === operationId
    && observation.outcome.status === 200
    && observation.outcome.visibility === 'observed';
}

function requestCoordinate(observation: RawObservation): { owner: string; repo: string } | null {
  const owner = observation.request.parameters.owner;
  const repo = observation.request.parameters.repo;
  return typeof owner === 'string' && typeof repo === 'string' ? { owner, repo } : null;
}

function sameRepositoryCoordinate(observation: RawObservation, repository: RepositoryIdentityFact): boolean {
  const coordinate = requestCoordinate(observation);
  return coordinate !== null
    && lower(coordinate.owner) === lower(repository.object.owner)
    && lower(coordinate.repo) === lower(repository.object.repo);
}

export function projectRepositoryIdentity(observation: RawObservation): RepositoryIdentityFact | null {
  if (!observed200(observation, 'repos/get')) return null;
  const coordinate = requestCoordinate(observation);
  const body = observation.outcome.value as {
    id?: unknown;
    node_id?: unknown;
    full_name?: unknown;
    name?: unknown;
    owner?: { login?: unknown };
  } | undefined;
  if (!coordinate || !body) return null;
  if (!Number.isSafeInteger(body.id) || Number(body.id) <= 0) return null;
  if (typeof body.node_id !== 'string' || body.node_id.length === 0) return null;
  if (typeof body.full_name !== 'string' || typeof body.name !== 'string') return null;
  if (typeof body.owner?.login !== 'string') return null;
  if (lower(body.owner.login) !== lower(coordinate.owner) || lower(body.name) !== lower(coordinate.repo)) return null;
  if (lower(body.full_name) !== lower(`${body.owner.login}/${body.name}`)) return null;

  return {
    kind: 'repository-identity',
    subject: {
      kind: 'github.repository',
      id: Number(body.id),
      node_id: body.node_id,
    },
    relation: 'named',
    object: {
      owner: body.owner.login,
      repo: body.name,
      full_name: body.full_name,
    },
    stability: 'stable-subject-mutable-alias',
    evidence: evidence(observation),
  };
}

export function projectGitRefTarget(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
): GitRefTargetFact | null {
  if (!observed200(observation, 'git/get-ref')) return null;
  if (!sameRepositoryCoordinate(observation, repository)) return null;
  const body = observation.outcome.value as {
    ref?: unknown;
    object?: { type?: unknown; sha?: unknown };
  } | undefined;
  if (!body || typeof body.ref !== 'string' || !body.object) return null;
  if (!['commit', 'tag'].includes(String(body.object.type))) return null;
  if (typeof body.object.sha !== 'string' || !sha.test(body.object.sha)) return null;

  const requestedRef = observation.request.parameters.ref;
  if (typeof requestedRef !== 'string') return null;
  if (canonicalRef(body.ref) !== canonicalRef(requestedRef)) return null;

  return {
    kind: 'binding',
    subject: {
      kind: 'github.ref',
      repository_id: repository.subject.id,
      ref: canonicalRef(body.ref),
    },
    relation: 'targets',
    object: {
      kind: body.object.type === 'commit' ? 'github.commit' : 'github.tag',
      sha: body.object.sha,
    },
    stability: 'mutable-snapshot',
    evidence: evidence(observation),
  };
}

export function projectGitCommit(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
): GitCommitFact | null {
  if (!observed200(observation, 'git/get-commit')) return null;
  if (!sameRepositoryCoordinate(observation, repository)) return null;
  const requestedSha = observation.request.parameters.commit_sha;
  const body = observation.outcome.value as {
    sha?: unknown;
    tree?: { sha?: unknown };
    parents?: Array<{ sha?: unknown }>;
  } | undefined;
  if (typeof requestedSha !== 'string' || !sha.test(requestedSha) || !body) return null;
  if (typeof body.sha !== 'string' || !sha.test(body.sha) || lower(body.sha) !== lower(requestedSha)) return null;
  if (typeof body.tree?.sha !== 'string' || !sha.test(body.tree.sha)) return null;
  if (!Array.isArray(body.parents) || body.parents.some(parent => typeof parent.sha !== 'string' || !sha.test(parent.sha))) return null;

  return {
    kind: 'immutable-object',
    subject: {
      kind: 'github.commit',
      repository_id: repository.subject.id,
      sha: body.sha,
    },
    tree_sha: body.tree.sha,
    parent_shas: body.parents.map(parent => String(parent.sha)),
    stability: 'content-addressed',
    evidence: evidence(observation),
  };
}

export function projectPullRequestSnapshot(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
): PullRequestSnapshotFact | null {
  if (!observed200(observation, 'pulls/get')) return null;
  if (!sameRepositoryCoordinate(observation, repository)) return null;
  const requested = observation.request.parameters.pull_number;
  const body = observation.outcome.value as {
    id?: unknown;
    node_id?: unknown;
    number?: unknown;
    state?: unknown;
    head?: { sha?: unknown };
    base?: { ref?: unknown; sha?: unknown };
  } | undefined;
  if (!Number.isSafeInteger(requested) || !body) return null;
  if (!Number.isSafeInteger(body.id) || Number(body.id) <= 0) return null;
  if (typeof body.node_id !== 'string' || body.node_id.length === 0) return null;
  if (!Number.isSafeInteger(body.number) || Number(body.number) !== Number(requested)) return null;
  if (typeof body.state !== 'string') return null;
  if (typeof body.head?.sha !== 'string' || !sha.test(body.head.sha)) return null;
  if (typeof body.base?.ref !== 'string' || typeof body.base.sha !== 'string' || !sha.test(body.base.sha)) return null;

  return {
    kind: 'entity-snapshot',
    subject: {
      kind: 'github.pull-request',
      repository_id: repository.subject.id,
      number: Number(body.number),
      id: Number(body.id),
      node_id: body.node_id,
    },
    state: body.state,
    head_sha: body.head.sha,
    base_ref: body.base.ref,
    base_sha: body.base.sha,
    stability: 'mutable-snapshot',
    evidence: evidence(observation),
  };
}

export function projectCheckRunsPage(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
): CheckRunsPageFact | null {
  if (!observed200(observation, 'checks/list-for-ref')) return null;
  if (!sameRepositoryCoordinate(observation, repository)) return null;
  const requestedRef = observation.request.parameters.ref;
  const body = observation.outcome.value as {
    total_count?: unknown;
    check_runs?: Array<{
      id?: unknown;
      name?: unknown;
      head_sha?: unknown;
      status?: unknown;
      conclusion?: unknown;
    }>;
  } | undefined;
  if (typeof requestedRef !== 'string' || !body) return null;
  if (!Number.isSafeInteger(body.total_count) || Number(body.total_count) < 0 || !Array.isArray(body.check_runs)) return null;
  const members: CheckRunMember[] = [];
  for (const run of body.check_runs) {
    if (!Number.isSafeInteger(run.id) || Number(run.id) <= 0) return null;
    if (typeof run.name !== 'string' || typeof run.head_sha !== 'string' || !sha.test(run.head_sha)) return null;
    if (typeof run.status !== 'string') return null;
    if (!(run.conclusion === null || typeof run.conclusion === 'string')) return null;
    members.push({
      id: Number(run.id),
      name: run.name,
      head_sha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion as string | null,
    });
  }
  const page = Number(observation.request.parameters.page ?? 1);
  const perPage = Number(observation.request.parameters.per_page ?? 30);
  const pagination = paginationShape(page, perPage, observation.response.link);
  if (!pagination) return null;

  return {
    kind: 'collection-page',
    subject: {
      kind: 'github.check-runs',
      repository_id: repository.subject.id,
      ref: requestedRef,
    },
    members,
    total_count: Number(body.total_count),
    ...pagination,
    evidence: evidence(observation),
  };
}

export function projectIssueSnapshot(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
): IssueSnapshotFact | null {
  if (!observed200(observation, 'issues/get')) return null;
  if (!sameRepositoryCoordinate(observation, repository)) return null;
  const requested = observation.request.parameters.issue_number;
  const body = observation.outcome.value as {
    id?: unknown;
    node_id?: unknown;
    number?: unknown;
    state?: unknown;
    title?: unknown;
    locked?: unknown;
    pull_request?: unknown;
  } | undefined;
  if (!Number.isSafeInteger(requested) || !body) return null;
  if (!Number.isSafeInteger(body.id) || Number(body.id) <= 0) return null;
  if (typeof body.node_id !== 'string' || body.node_id.length === 0) return null;
  if (!Number.isSafeInteger(body.number) || Number(body.number) !== Number(requested)) return null;
  if (typeof body.state !== 'string' || typeof body.title !== 'string' || typeof body.locked !== 'boolean') return null;

  return {
    kind: 'entity-snapshot',
    subject: {
      kind: 'github.issue',
      repository_id: repository.subject.id,
      number: Number(body.number),
      id: Number(body.id),
      node_id: body.node_id,
    },
    state: body.state,
    title: body.title,
    locked: body.locked,
    is_pull_request: body.pull_request !== undefined && body.pull_request !== null,
    stability: 'mutable-snapshot',
    evidence: evidence(observation),
  };
}

export function sameGithubEntity(
  left: PullRequestSnapshotFact | IssueSnapshotFact,
  right: PullRequestSnapshotFact | IssueSnapshotFact,
): boolean {
  return sameEntityIdentity(left.subject, right.subject);
}

export function projectCommitStatusesPage(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
): CommitStatusesPageFact | null {
  if (!observed200(observation, 'repos/list-commit-statuses-for-ref')) return null;
  if (!sameRepositoryCoordinate(observation, repository)) return null;
  const requestedRef = observation.request.parameters.ref;
  const body = observation.outcome.value as Array<{
    id?: unknown;
    node_id?: unknown;
    state?: unknown;
    context?: unknown;
    target_url?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
  }> | undefined;
  if (typeof requestedRef !== 'string' || !Array.isArray(body)) return null;

  const members: CommitStatusMember[] = [];
  for (const status of body) {
    if (!Number.isSafeInteger(status.id) || Number(status.id) <= 0) return null;
    if (typeof status.node_id !== 'string' || status.node_id.length === 0) return null;
    if (typeof status.state !== 'string' || typeof status.context !== 'string') return null;
    if (!(status.target_url === null || typeof status.target_url === 'string')) return null;
    if (typeof status.created_at !== 'string' || typeof status.updated_at !== 'string') return null;
    members.push({
      id: Number(status.id),
      node_id: status.node_id,
      state: status.state,
      context: status.context,
      target_url: status.target_url as string | null,
      created_at: status.created_at,
      updated_at: status.updated_at,
    });
  }

  const page = Number(observation.request.parameters.page ?? 1);
  const perPage = Number(observation.request.parameters.per_page ?? 30);
  const pagination = paginationShape(page, perPage, observation.response.link);
  if (!pagination) return null;

  return {
    kind: 'collection-page',
    subject: {
      kind: 'github.commit-statuses',
      repository_id: repository.subject.id,
      ref: requestedRef,
    },
    members,
    ...pagination,
    evidence: evidence(observation),
  };
}

export function evaluateGitRefTarget(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
  obligation: GitRefTargetObligation,
): ObligationEvaluation<GitRefTargetFact> {
  if (observation.outcome.visibility === 'not-observed') {
    return { state: 'INDETERMINATE', reason: 'NOT_VISIBLE_IS_NOT_ABSENCE' };
  }
  if (observation.outcome.visibility === 'indeterminate') {
    return { state: 'INDETERMINATE', reason: 'OBSERVATION_INDETERMINATE' };
  }
  const fact = projectGitRefTarget(observation, repository);
  if (!fact) return { state: 'INDETERMINATE', reason: 'OBSERVATION_DOES_NOT_PROVE_REF_BINDING' };

  const sameCoordinate = fact.subject.repository_id === obligation.repository_id
    && fact.subject.ref === canonicalRef(obligation.ref);
  if (!sameCoordinate) return { state: 'INDETERMINATE', reason: 'OBSERVATION_COORDINATE_MISMATCH', fact };

  return lower(fact.object.sha) === lower(obligation.target_sha)
    ? { state: 'SATISFIED', reason: 'AUTHORITATIVE_BINDING_MATCHES', fact }
    : { state: 'UNSATISFIED', reason: 'AUTHORITATIVE_BINDING_DIFFERS', fact };
}

export function evaluatePullRequestSnapshot(
  fact: PullRequestSnapshotFact,
  obligation: PullRequestObligation,
): ObligationEvaluation<PullRequestSnapshotFact> {
  return evaluateMutableEntity({
    fact,
    obligation,
    coordinateMatches: (candidate, expected) =>
      candidate.subject.repository_id === expected.repository_id
      && candidate.subject.number === expected.number,
    differs: (candidate, expected) => [
      expected.state !== undefined && candidate.state !== expected.state,
      expected.head_sha !== undefined && lower(candidate.head_sha) !== lower(expected.head_sha),
      expected.base_ref !== undefined && candidate.base_ref !== expected.base_ref,
    ].some(Boolean),
  });
}

export function evaluateIssueSnapshot(
  fact: IssueSnapshotFact,
  obligation: IssueObligation,
): ObligationEvaluation<IssueSnapshotFact> {
  return evaluateMutableEntity({
    fact,
    obligation,
    coordinateMatches: (candidate, expected) =>
      candidate.subject.repository_id === expected.repository_id
      && candidate.subject.number === expected.number,
    differs: (candidate, expected) => [
      expected.state !== undefined && candidate.state !== expected.state,
      expected.title !== undefined && candidate.title !== expected.title,
      expected.locked !== undefined && candidate.locked !== expected.locked,
    ].some(Boolean),
  });
}

export function evaluateCheckRunPage(
  fact: CheckRunsPageFact,
  obligation: CheckRunObligation,
): ObligationEvaluation<CheckRunsPageFact> {
  return evaluatePositiveCollectionMember({
    fact,
    obligation,
    coordinateMatches: (candidate, expected) =>
      candidate.subject.repository_id === expected.repository_id
      && candidate.subject.ref === expected.ref,
    memberMatches: (candidate, expected) =>
      (expected.id === undefined || candidate.id === expected.id)
      && (expected.name === undefined || candidate.name === expected.name)
      && (expected.head_sha === undefined || lower(candidate.head_sha) === lower(expected.head_sha)),
    memberDiffers: (candidate, expected) =>
      (expected.status !== undefined && candidate.status !== expected.status)
      || (expected.conclusion !== undefined && candidate.conclusion !== expected.conclusion),
  });
}

export function evaluateCommitStatusPage(
  fact: CommitStatusesPageFact,
  obligation: CommitStatusObligation,
): ObligationEvaluation<CommitStatusesPageFact> {
  return evaluatePositiveCollectionMember({
    fact,
    obligation,
    coordinateMatches: (candidate, expected) =>
      candidate.subject.repository_id === expected.repository_id
      && candidate.subject.ref === expected.ref,
    memberMatches: (candidate, expected) =>
      (expected.id === undefined || candidate.id === expected.id)
      && (expected.node_id === undefined || candidate.node_id === expected.node_id)
      && (expected.context === undefined || candidate.context === expected.context),
    memberDiffers: (candidate, expected) =>
      expected.state !== undefined && candidate.state !== expected.state,
  });
}

function sameRequestCoordinate(left: RawObservation, right: RawObservation): boolean {
  if (left.contract.provider !== right.contract.provider) return false;
  if (left.contract.api_version !== right.contract.api_version) return false;
  if (left.contract.operation_id !== right.contract.operation_id) return false;
  if (left.contract.schema_sha256 !== right.contract.schema_sha256) return false;
  if (left.request.method !== right.request.method || left.request.path !== right.request.path) return false;
  return JSON.stringify(left.request.parameters) === JSON.stringify(right.request.parameters);
}

function header(headers: Record<string, string>, name: string): string | null {
  const found = Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? null;
}

export function revalidateNotModified(
  prior: RawObservation,
  current: RawObservation,
): RevalidatedObservation | null {
  if (prior.outcome.visibility !== 'observed' || prior.outcome.status < 200 || prior.outcome.status >= 300) return null;
  if (current.outcome.status !== 304 || current.outcome.visibility !== 'indeterminate') return null;
  if (!sameRequestCoordinate(prior, current)) return null;
  const priorEtag = prior.response.etag;
  if (!priorEtag) return null;
  if (header(current.request.headers, 'if-none-match') !== priorEtag) return null;

  return {
    ...prior,
    observer: structuredClone(current.observer),
    observed_at: current.observed_at,
    request: structuredClone(current.request),
    response: {
      ...current.response,
      etag: current.response.etag ?? priorEtag,
    },
    revalidated_from: {
      observed_at: prior.observed_at,
      etag: priorEtag,
    },
  };
}
