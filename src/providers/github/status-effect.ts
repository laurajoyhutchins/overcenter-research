import type { KernelCore } from '../../authority/engine.ts';
import type { ExecutionPermit } from '../../model.ts';
import { GITHUB_COMMIT_STATUS_EFFECT } from '../../effect-adapter.ts';
import { observeCertifiedGithubRepository } from './certified-repository.ts';
import { githubGetAsync, runGithubReadObserverAsync, type GithubJsonGetAsync } from './rest.ts';
import {
  createGithubStatusPost,
  githubStatusNotDispatchedWitness,
  type GithubStatusMutationBody,
  type GithubStatusPost,
} from './status-transport.ts';

export { GITHUB_COMMIT_STATUS_EFFECT } from '../../effect-adapter.ts';
export { createGithubStatusPost } from './status-transport.ts';
export type { GithubStatusMutationBody, GithubStatusPost } from './status-transport.ts';

const githubPost = createGithubStatusPost();

export async function performGithubCommitStatusEffect(
  kernel: KernelCore,
  permit: ExecutionPermit,
  {
    token,
    get = githubGetAsync,
    post = githubPost,
    clock = () => new Date().toISOString(),
  }: {
    token: string;
    get?: GithubJsonGetAsync;
    post?: GithubStatusPost;
    clock?: () => string;
  },
): Promise<{
  repository_id: number;
  repository_full_name: string;
  commit_sha: string;
  context: string;
  state: 'error' | 'failure' | 'pending' | 'success';
}> {
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');

  const authority = kernel.authorizeEffect(permit, GITHUB_COMMIT_STATUS_EFFECT);
  const p = authority.postcondition;
  const repository = await runGithubReadObserverAsync(
    token,
    (syncGet) =>
      observeCertifiedGithubRepository(token, {
        repositoryId: p.repository_id,
        repositoryFullName: p.repository_full_name,
        get: syncGet,
        clock,
        observerId: 'github-commit-status-effect/v1',
      }),
    get,
  );
  const { owner, repo, full_name } = repository.fact.object;
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(p.commit_sha)}`;
  const body: GithubStatusMutationBody = {
    state: p.expected_state,
    context: p.context,
    description: 'Overcenter trusted effect broker',
  };

  try {
    return await kernel.performEffect(authority, async (attempt) => {
      const response = await post(token, path, body, attempt);
      if (response.status !== 201) {
        throw new Error(`GITHUB_STATUS_MUTATION_FAILED:${response.status}:${response.body}`);
      }
      return {
        repository_id: p.repository_id,
        repository_full_name: full_name,
        commit_sha: p.commit_sha,
        context: p.context,
        state: p.expected_state,
      };
    });
  } catch (error: unknown) {
    const witness = githubStatusNotDispatchedWitness(error);
    if (witness) {
      kernel.releaseEffectReservation(authority, witness, {
        source: 'github-status/fresh-https',
      });
    }
    throw error;
  }
}
