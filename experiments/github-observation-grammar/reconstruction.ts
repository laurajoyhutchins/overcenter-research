import type {
  GitCommitFact,
  GithubFact,
  GitRefTargetFact,
  PullRequestSnapshotFact,
  RepositoryIdentityFact,
} from './semantics.ts';

export interface GithubProjection {
  repositories: Record<string, RepositoryIdentityFact>;
  commits: Record<string, GitCommitFact>;
  refs: Record<string, GitRefTargetFact>;
  pull_requests: Record<string, PullRequestSnapshotFact>;
}

const repoKey = (id: number) => String(id);
const commitKey = (fact: GitCommitFact) => `${fact.subject.repository_id}:${fact.subject.sha.toLowerCase()}`;
const refKey = (fact: GitRefTargetFact) => `${fact.subject.repository_id}:${fact.subject.ref}`;
const prKey = (fact: PullRequestSnapshotFact) => `${fact.subject.repository_id}:${fact.subject.number}`;

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
    if (fact.kind === 'binding') refs[refKey(fact)] = newer(refs[refKey(fact)], fact);
    if (fact.kind === 'entity-snapshot') pullRequests[prKey(fact)] = newer(pullRequests[prKey(fact)], fact);
  }

  return {
    repositories,
    commits,
    refs,
    pull_requests: pullRequests,
  };
}
