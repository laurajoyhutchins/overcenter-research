import type { KernelCore } from '../authority/engine.ts';
import { effectAdapterCapabilities, GITHUB_COMMIT_STATUS_EFFECT } from '../effect-adapter.ts';
import type { Data, ExecutionPermit } from '../model.ts';
import { performGithubCommitStatusEffect, type GithubStatusPost } from './github/status-effect.ts';
import type { GithubJsonGetAsync } from './github/rest.ts';

export interface TrustedEffectDispatchContext {
  github?: {
    token: string;
    get?: GithubJsonGetAsync;
    statusPost?: GithubStatusPost;
    clock?: () => string;
  };
}

export async function dispatchAdmittedEffect(
  kernel: KernelCore,
  permit: ExecutionPermit,
  context: TrustedEffectDispatchContext,
): Promise<Data> {
  const work = kernel.claimedWork(permit);
  const capabilities = effectAdapterCapabilities(work.packet.effect_contract);
  if (!capabilities) {
    throw new Error(
      `REGISTERED_EFFECT_DISPATCH_UNREGISTERED:${String(work.packet.effect_contract)}`,
    );
  }
  if (capabilities.effect_contract !== GITHUB_COMMIT_STATUS_EFFECT) {
    throw new Error(`REGISTERED_EFFECT_DISPATCH_NOT_ADMITTED:${capabilities.effect_contract}`);
  }

  const github = context.github;
  if (!github) throw new Error('REGISTERED_EFFECT_DISPATCH_GITHUB_CONTEXT_REQUIRED');
  return await performGithubCommitStatusEffect(kernel, permit, {
    token: github.token,
    ...(github.get ? { get: github.get } : {}),
    ...(github.statusPost ? { post: github.statusPost } : {}),
    ...(github.clock ? { clock: github.clock } : {}),
  });
}
