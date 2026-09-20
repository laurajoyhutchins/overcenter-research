import type { RawObservation } from './openapi.ts';
import { structurallyValidatedFor } from '../provider-observation/response-slice.ts';
import { RESPONSE_SLICES } from './response-slices.ts';
import {
  evaluateMutableEntity,
  evaluatePositiveCollectionMember,
  paginationShape,
  sameEntityIdentity,
  type MutableEntitySnapshot,
  type NumberedEntitySubject,
  type CollectionPageShape,
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

export type PullRequestSnapshotFact = MutableEntitySnapshot<
  'github.pull-request',
  {
    state: string;
    head_sha: string;
    base_ref: string;
    base_sha: string;
  },
  FactEvidence
>;

export type IssueSnapshotFact = MutableEntitySnapshot<
  'github.issue',
  {
    state: string;
    title: string;
    locked: boolean;
    is_pull_request: boolean;
  },
  FactEvidence
>;

export interface CheckRunMember {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
}

export type CheckRunsPageFact = CollectionPageShape<
  { kind: 'github.check-runs'; repository_id: number; ref: string },
  CheckRunMember,
  FactEvidence,
  { total_count: number }
>;

export interface CommitStatusMember {
  id: number;
  node_id: string;
  state: string;
  context: string;
  target_url: string | null;
  created_at: string;
  updated_at: string;
}

export type CommitStatusesPageFact = CollectionPageShape<
  { kind: 'github.commit-statuses'; repository_id: number; ref: string },
  CommitStatusMember,
  FactEvidence
>;

export interface WorkflowRunMember {
  id: number;
  node_id: string;
  workflow_id: number;
  run_number: number;
  run_attempt: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
}

export type WorkflowRunsPageFact = CollectionPageShape<
  { kind: 'github.workflow-runs'; repository_id: number },
  WorkflowRunMember,
  FactEvidence,
  { total_count: number }
>;

export type GithubFact =
  | RepositoryIdentityFact
  | GitRefTargetFact
  | GitCommitFact
  | PullRequestSnapshotFact
  | IssueSnapshotFact
  | CheckRunsPageFact
  | CommitStatusesPageFact
  | WorkflowRunsPageFact;

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

export interface WorkflowRunObligation {
  repository_id: number;
  id?: number;
  node_id?: string;
  workflow_id?: number;
  head_sha?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
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

function requiredResponsePaths(
  operationId:keyof typeof RESPONSE_SLICES,
):string[] {
  return RESPONSE_SLICES[operationId]
    .filter(field=>field.required!==false)
    .map(field=>field.path);
}

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

function numberedEntityBase<Kind extends string>(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
  {
    operationId,
    parameter,
    kind,
  }: { operationId: 'pulls/get' | 'issues/get'; parameter: string; kind: Kind },
): { subject: NumberedEntitySubject<Kind>; body: Record<string, unknown> } | null {
  const requiredPaths = requiredResponsePaths(operationId);
  if (!structurallyValidatedFor(observation, operationId, requiredPaths)) return null;
  if (!sameRepositoryCoordinate(observation, repository)) return null;

  const requested = observation.request.parameters[parameter];
  if (!Number.isSafeInteger(requested)) return null;
  const body = observation.outcome.value as {
    id: number;
    node_id: string;
    number: number;
  } & Record<string, unknown>;
  if (body.id <= 0 || body.node_id.length === 0 || body.number !== requested) return null;

  return {
    subject: {
      kind,
      repository_id: repository.subject.id,
      number: body.number,
      id: body.id,
      node_id: body.node_id,
    },
    body,
  };
}

type CollectionOperationId =
  | 'checks/list-for-ref'
  | 'repos/list-commit-statuses-for-ref'
  | 'actions/list-workflow-runs-for-repo';

function collectionBase(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
  operationId: CollectionOperationId,
): {
  body: unknown;
  pagination: NonNullable<ReturnType<typeof paginationShape>>;
  evidence: FactEvidence;
} | null {
  const requiredPaths = requiredResponsePaths(operationId);
  if (!structurallyValidatedFor(observation, operationId, requiredPaths)) return null;
  if (!sameRepositoryCoordinate(observation, repository)) return null;
  const page = Number(observation.request.parameters.page ?? 1);
  const perPage = Number(observation.request.parameters.per_page ?? 30);
  const pagination = paginationShape(page, perPage, observation.response.link);
  if (!pagination) return null;
  return {
    body: observation.outcome.value,
    pagination,
    evidence: evidence(observation),
  };
}

function refCollectionBase(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
  operationId: Exclude<CollectionOperationId, 'actions/list-workflow-runs-for-repo'>,
): {
  ref: string;
  body: unknown;
  pagination: NonNullable<ReturnType<typeof paginationShape>>;
  evidence: FactEvidence;
} | null {
  const base = collectionBase(observation, repository, operationId);
  if (!base) return null;
  const ref = observation.request.parameters.ref;
  if (typeof ref !== 'string') return null;
  return { ref, ...base };
}

export function projectRepositoryIdentity(observation: RawObservation): RepositoryIdentityFact | null {
  const requiredPaths = requiredResponsePaths('repos/get');
  if (!structurallyValidatedFor(observation, 'repos/get', requiredPaths)) return null;

  const coordinate = requestCoordinate(observation);
  if (!coordinate) return null;
  const body = observation.outcome.value as {
    id: number;
    node_id: string;
    full_name: string;
    name: string;
    owner: { login: string };
  };
  if (body.id <= 0) return null;
  if (lower(body.owner.login) !== lower(coordinate.owner) || lower(body.name) !== lower(coordinate.repo)) return null;
  if (lower(body.full_name) !== lower(`${body.owner.login}/${body.name}`)) return null;

  return {
    kind: 'repository-identity',
    subject: {
      kind: 'github.repository',
      id: body.id,
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
  const requiredPaths = requiredResponsePaths('git/get-ref');
  if (!structurallyValidatedFor(observation, 'git/get-ref', requiredPaths)) return null;
  if (!sameRepositoryCoordinate(observation, repository)) return null;

  const body = observation.outcome.value as {
    ref: string;
    object: { type: string; sha: string };
  };
  if (!['commit', 'tag'].includes(body.object.type)) return null;
  if (!sha.test(body.object.sha)) return null;

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
  const requiredPaths = requiredResponsePaths('git/get-commit');
  if (!structurallyValidatedFor(observation, 'git/get-commit', requiredPaths)) return null;
  if (!sameRepositoryCoordinate(observation, repository)) return null;

  const requestedSha = observation.request.parameters.commit_sha;
  if (typeof requestedSha !== 'string' || !sha.test(requestedSha)) return null;
  const body = observation.outcome.value as {
    sha: string;
    tree: { sha: string };
    parents: Array<{ sha: string }>;
  };
  if (!sha.test(body.sha) || lower(body.sha) !== lower(requestedSha)) return null;
  if (!sha.test(body.tree.sha)) return null;
  if (body.parents.some(parent => !sha.test(parent.sha))) return null;

  return {
    kind: 'immutable-object',
    subject: {
      kind: 'github.commit',
      repository_id: repository.subject.id,
      sha: body.sha,
    },
    tree_sha: body.tree.sha,
    parent_shas: body.parents.map(parent => parent.sha),
    stability: 'content-addressed',
    evidence: evidence(observation),
  };
}

export function projectPullRequestSnapshot(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
): PullRequestSnapshotFact | null {
  const base = numberedEntityBase(observation, repository, {
    operationId: 'pulls/get',
    parameter: 'pull_number',
    kind: 'github.pull-request',
  });
  if (!base) return null;
  const body = base.body as {
    state: string;
    head: { sha: string };
    base: { ref: string; sha: string };
  };
  if (!sha.test(body.head.sha) || !sha.test(body.base.sha)) return null;

  return {
    kind: 'entity-snapshot',
    subject: base.subject,
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
  const base = refCollectionBase(observation, repository, 'checks/list-for-ref');
  if (!base) return null;
  const body = base.body as {
    total_count: number;
    check_runs: Array<{
      id: number;
      name: string;
      head_sha: string;
      status: string;
      conclusion: string | null;
    }>;
  };
  if (body.total_count < 0) return null;

  const members: CheckRunMember[] = [];
  for (const run of body.check_runs) {
    if (run.id <= 0 || !sha.test(run.head_sha)) return null;
    members.push({ ...run });
  }

  return {
    kind: 'collection-page',
    subject: {
      kind: 'github.check-runs',
      repository_id: repository.subject.id,
      ref: base.ref,
    },
    members,
    total_count: body.total_count,
    ...base.pagination,
    evidence: base.evidence,
  };
}

export function projectIssueSnapshot(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
): IssueSnapshotFact | null {
  const base = numberedEntityBase(observation, repository, {
    operationId: 'issues/get',
    parameter: 'issue_number',
    kind: 'github.issue',
  });
  if (!base) return null;
  const body = base.body as {
    state: string;
    title: string;
    locked: boolean;
    pull_request?: unknown;
  };

  return {
    kind: 'entity-snapshot',
    subject: base.subject,
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
  const base = refCollectionBase(observation, repository, 'repos/list-commit-statuses-for-ref');
  if (!base) return null;

  const members: CommitStatusMember[] = [];
  for (const status of base.body as CommitStatusMember[]) {
    if (status.id <= 0 || status.node_id.length === 0) return null;
    members.push({ ...status });
  }

  return {
    kind: 'collection-page',
    subject: {
      kind: 'github.commit-statuses',
      repository_id: repository.subject.id,
      ref: base.ref,
    },
    members,
    ...base.pagination,
    evidence: base.evidence,
  };
}

export function projectWorkflowRunsPage(
  observation: RawObservation,
  repository: RepositoryIdentityFact,
): WorkflowRunsPageFact | null {
  const base = collectionBase(observation, repository, 'actions/list-workflow-runs-for-repo');
  if (!base) return null;
  const body = base.body as {
    total_count: number;
    workflow_runs: WorkflowRunMember[];
  };
  if (body.total_count < 0) return null;

  const members: WorkflowRunMember[] = [];
  for (const run of body.workflow_runs) {
    if (run.id <= 0 || run.node_id.length === 0) return null;
    if (run.workflow_id <= 0 || run.run_number <= 0 || run.run_attempt <= 0) return null;
    if (!sha.test(run.head_sha)) return null;
    members.push({ ...run });
  }

  return {
    kind: 'collection-page',
    subject: {
      kind: 'github.workflow-runs',
      repository_id: repository.subject.id,
    },
    members,
    total_count: body.total_count,
    ...base.pagination,
    evidence: base.evidence,
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

export function evaluateWorkflowRunPage(
  fact: WorkflowRunsPageFact,
  obligation: WorkflowRunObligation,
): ObligationEvaluation<WorkflowRunsPageFact> {
  return evaluatePositiveCollectionMember({
    fact,
    obligation,
    coordinateMatches: (candidate, expected) =>
      candidate.subject.repository_id === expected.repository_id,
    memberMatches: (candidate, expected) =>
      (expected.id === undefined || candidate.id === expected.id)
      && (expected.node_id === undefined || candidate.node_id === expected.node_id)
      && (expected.workflow_id === undefined || candidate.workflow_id === expected.workflow_id)
      && (expected.head_sha === undefined || lower(candidate.head_sha) === lower(expected.head_sha)),
    memberDiffers: (candidate, expected) =>
      (expected.event !== undefined && candidate.event !== expected.event)
      || (expected.status !== undefined && candidate.status !== expected.status)
      || (expected.conclusion !== undefined && candidate.conclusion !== expected.conclusion),
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
