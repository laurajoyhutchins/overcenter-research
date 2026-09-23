import type { EffectAuthority, KernelCore } from '../../authority/engine.ts';
import { GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT } from '../../effect-adapter.ts';
import { GITHUB_API_VERSION } from './contract.ts';
import { observeCertifiedGithubPullRequestIdentity } from './certified-pr.ts';
import { githubGetAsync, runGithubReadObserverAsync, type GithubJsonGetAsync } from './rest.ts';

export { GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT } from '../../effect-adapter.ts';

export type GithubUpdateBranchPut = (
  token: string,
  path: string,
  body: { expected_head_sha: string },
) => Promise<{ status: number; body: string }>;

async function githubPut(
  token: string,
  path: string,
  body: { expected_head_sha: string },
): Promise<{ status: number; body: string }> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: 'PUT',
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

export async function performGithubPullRequestUpdateBranchEffect(
  kernel: KernelCore,
  authority: EffectAuthority<
    typeof GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
    'github-pull-request-branch-updated/v1'
  >,
  {
    token,
    get = githubGetAsync,
    put = githubPut,
    clock = () => new Date().toISOString(),
  }: {
    token: string;
    get?: GithubJsonGetAsync;
    put?: GithubUpdateBranchPut;
    clock?: () => string;
  },
): Promise<{
  repository_id: number;
  repository_full_name: string;
  pull_number: number;
  previous_head_sha: string;
}> {
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
  const p = authority.postcondition;
  const identity = await runGithubReadObserverAsync(
    token,
    (syncGet) =>
      observeCertifiedGithubPullRequestIdentity(token, {
        repositoryId: p.repository_id,
        repositoryFullName: p.repository_full_name,
        pullNumber: p.pull_number,
        expected: {
          node_id: p.pull_node_id,
          state: 'open',
          head_sha: p.expected_previous_head_sha,
          base_ref: p.base_ref,
          base_sha: p.expected_base_sha,
        },
        get: syncGet,
        clock,
      }),
    get,
  );
  if (identity.state !== 'CURRENT' || !identity.repository_full_name) {
    throw new Error(`GITHUB_PR_UPDATE_BRANCH_IDENTITY_NOT_CURRENT:${identity.reason}`);
  }
  const [owner, repo] = identity.repository_full_name.split('/');
  if (!owner || !repo) throw new Error('GITHUB_PR_UPDATE_BRANCH_REPOSITORY_INVALID');
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${p.pull_number}/update-branch`;

  return kernel.performEffect(authority, async () => {
    const response = await put(token, path, { expected_head_sha: p.expected_previous_head_sha });
    if (response.status !== 202) {
      throw new Error(`GITHUB_PR_UPDATE_BRANCH_FAILED:${response.status}:${response.body}`);
    }
    return {
      repository_id: p.repository_id,
      repository_full_name: identity.repository_full_name!,
      pull_number: p.pull_number,
      previous_head_sha: p.expected_previous_head_sha,
    };
  });
}
