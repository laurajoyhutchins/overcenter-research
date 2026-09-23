import type { KernelCore } from '../authority/engine.ts';
import {
  EFFECT_ADAPTER_CAPABILITIES,
  GITHUB_COMMIT_STATUS_EFFECT,
  GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT,
} from '../effect-adapter.ts';
import type { Data, ExecutionPermit } from '../model.ts';
import { performGithubCommitStatusEffect, type GithubStatusPost } from './github/status-effect.ts';
import {
  performGithubPullRequestUpdateBranchEffect,
  type GithubUpdateBranchPut,
} from './github/pr-update-branch-effect.ts';
import type { GithubJsonGetAsync } from './github/rest.ts';

export interface TrustedEffectDispatchContext {
  github?: {
    token: string;
    get?: GithubJsonGetAsync;
    statusPost?: GithubStatusPost;
    updateBranchPut?: GithubUpdateBranchPut;
    clock?: () => string;
  };
}

export async function dispatchRegisteredEffect(
  kernel: KernelCore,
  permit: ExecutionPermit,
  context: TrustedEffectDispatchContext,
): Promise<Data> {
  const work = kernel.claimedWork(permit);
  const adapter = EFFECT_ADAPTER_CAPABILITIES.find(
    (candidate) => candidate.effect_contract === work.packet.effect_contract,
  );
  if (!adapter) {
    throw new Error(
      `REGISTERED_EFFECT_DISPATCH_UNREGISTERED:${String(work.packet.effect_contract)}`,
    );
  }

  const github = context.github;
  if (!github) throw new Error('REGISTERED_EFFECT_DISPATCH_GITHUB_CONTEXT_REQUIRED');

  if (adapter.effect_contract === GITHUB_COMMIT_STATUS_EFFECT) {
    return await performGithubCommitStatusEffect(kernel, permit, {
      token: github.token,
      ...(github.get ? { get: github.get } : {}),
      ...(github.statusPost ? { post: github.statusPost } : {}),
      ...(github.clock ? { clock: github.clock } : {}),
    });
  }

  if (adapter.effect_contract === GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT) {
    return await performGithubPullRequestUpdateBranchEffect(kernel, permit, {
      token: github.token,
      ...(github.get ? { get: github.get } : {}),
      ...(github.updateBranchPut ? { put: github.updateBranchPut } : {}),
      ...(github.clock ? { clock: github.clock } : {}),
    });
  }

  const unsupported: never = adapter;
  throw new Error(`REGISTERED_EFFECT_DISPATCH_UNSUPPORTED:${String(unsupported)}`);
}
