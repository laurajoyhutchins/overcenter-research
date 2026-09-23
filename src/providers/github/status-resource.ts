import { GITHUB_COMMIT_STATUS_EFFECT } from '../../effect-adapter.ts';
import type { Data } from '../../model.ts';
import { defineSemanticEffect } from '../../semantic-effect.ts';

export type GithubCommitStatusTarget = Data & {
  repository_id: number;
  repository_full_name: string;
  commit_sha: string;
  context: string;
};

export type GithubCommitStatusDesired = Data & {
  state: 'error' | 'failure' | 'pending' | 'success';
};

export const githubCommitStatus = defineSemanticEffect<
  typeof GITHUB_COMMIT_STATUS_EFFECT,
  GithubCommitStatusTarget,
  GithubCommitStatusDesired
>({
  resource: 'github.commit-status',
  effectContract: GITHUB_COMMIT_STATUS_EFFECT,
  postcondition: (target, desired) => ({
    provider: 'github',
    repository_id: target.repository_id,
    repository_full_name: target.repository_full_name,
    commit_sha: target.commit_sha,
    context: target.context,
    expected_state: desired.state,
  }),
});
