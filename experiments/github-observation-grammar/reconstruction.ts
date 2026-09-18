import type {
  GitCommitFact,
  GithubFact,
  GitRefTargetFact,
  IssueSnapshotFact,
  PullRequestSnapshotFact,
  RepositoryIdentityFact,
} from './semantics.ts';

export interface GithubEntityProjection {
  repository_id: number;
  node_id: string;
  pull_request?: PullRequestSnapshotFact;
  issue?: IssueSnapshotFact;
}

export interface GithubProjection {
  repositories: Record<string, RepositoryIdentityFact>;
  commits: Record<string, GitCommitFact>;
  refs: Record<string, GitRefTargetFact>;
  pull_requests: Record<string, PullRequestSnapshotFact>;
  issues: Record<string, IssueSnapshotFact>;
  entities: Record<string, GithubEntityProjection>;
}

const repoKey = (id: number) => String(id);
const commitKey = (fact: GitCommitFact) => `${fact.subject.repository_id}:${fact.subject.sha.toLowerCase()}`;
const refKey = (fact: GitRefTargetFact) => `${fact.subject.repository_id}:${fact.subject.ref}`;
const numberedEntityKey = (repositoryId: number, number: number) => `${repositoryId}:${number}`;
const nodeEntityKey = (repositoryId: number, nodeId: string) => `${repositoryId}:${nodeId}`;

function newer<T extends GithubFact>(left: T | undefined, right: T): T {
  if (!left) return right;
  return left.evidence.observed_at >= right.evidence.observed_at ? left : right;
}

export function reconstructGithubProjection({
  durable,
  current,
}: {
  durable: GithubFact[];
  current: GithubFact[];
}): GithubProjection {
  const repositories: Record<string, RepositoryIdentityFact> = {};
  const commits: Record<string, GitCommitFact> = {};
  const refs: Record<string, GitRefTargetFact> = {};
  const pullRequests: Record<string, PullRequestSnapshotFact> = {};
  const issues: Record<string, IssueSnapshotFact> = {};
  const entities: Record<string, GithubEntityProjection> = {};

  // Stable identities and content-addressed objects can be reused from durable facts.
  for (const fact of [...durable, ...current]) {
    if (fact.kind === 'repository-identity') {
      repositories[repoKey(fact.subject.id)] = newer(repositories[repoKey(fact.subject.id)], fact);
    }
    if (fact.kind === 'immutable-object') {
      commits[commitKey(fact)] = fact;
    }
  }

  // Mutable provider state is reconstructed only from explicitly current authority.
  for (const fact of current) {
    if (fact.kind === 'binding') {
      refs[refKey(fact)] = newer(refs[refKey(fact)], fact);
      continue;
    }
    if (fact.kind !== 'entity-snapshot') continue;

    const surfaceKey = numberedEntityKey(fact.subject.repository_id, fact.subject.number);
    const entityKey = nodeEntityKey(fact.subject.repository_id, fact.subject.node_id);
    const entity = entities[entityKey] ?? {
      repository_id: fact.subject.repository_id,
      node_id: fact.subject.node_id,
    };

    if (fact.subject.kind === 'github.pull-request') {
      const selected = newer(pullRequests[surfaceKey], fact) as PullRequestSnapshotFact;
      pullRequests[surfaceKey] = selected;
      entity.pull_request = newer(entity.pull_request, selected) as PullRequestSnapshotFact;
    }

    if (fact.subject.kind === 'github.issue') {
      const selected = newer(issues[surfaceKey], fact) as IssueSnapshotFact;
      issues[surfaceKey] = selected;
      entity.issue = newer(entity.issue, selected) as IssueSnapshotFact;
    }

    entities[entityKey] = entity;
  }

  return {
    repositories,
    commits,
    refs,
    pull_requests: pullRequests,
    issues,
    entities,
  };
}
