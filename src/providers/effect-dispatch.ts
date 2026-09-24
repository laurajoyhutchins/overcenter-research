import type { KernelCore } from '../authority/engine.ts';
import {
  effectAdapterCapabilities,
  GITHUB_COMMIT_STATUS_EFFECT,
  KUBERNETES_CONFIGMAP_EFFECT,
} from '../effect-adapter.ts';
import type { Data, ExecutionPermit } from '../model.ts';
import { performGithubCommitStatusEffect, type GithubStatusPost } from './github/status-effect.ts';
import type { GithubJsonGetAsync } from './github/rest.ts';
import {
  performKubernetesConfigMapEffect,
  type KubernetesConfigMapApply,
} from './kubernetes/configmap-effect.ts';

export interface TrustedEffectDispatchContext {
  github?: {
    token: string;
    get?: GithubJsonGetAsync;
    statusPost?: GithubStatusPost;
    clock?: () => string;
  };
  kubernetes?: {
    configMapApply: KubernetesConfigMapApply;
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
  if (capabilities.effect_contract === GITHUB_COMMIT_STATUS_EFFECT) {
    const github = context.github;
    if (!github) throw new Error('REGISTERED_EFFECT_DISPATCH_GITHUB_CONTEXT_REQUIRED');
    return await performGithubCommitStatusEffect(kernel, permit, {
      token: github.token,
      ...(github.get ? { get: github.get } : {}),
      ...(github.statusPost ? { post: github.statusPost } : {}),
      ...(github.clock ? { clock: github.clock } : {}),
    });
  }

  if (capabilities.effect_contract === KUBERNETES_CONFIGMAP_EFFECT) {
    const kubernetes = context.kubernetes;
    if (!kubernetes) throw new Error('REGISTERED_EFFECT_DISPATCH_KUBERNETES_CONTEXT_REQUIRED');
    const authority = kernel.authorizeEffect(permit, KUBERNETES_CONFIGMAP_EFFECT);
    return await performKubernetesConfigMapEffect(kernel, authority, {
      apply: kubernetes.configMapApply,
    });
  }

  throw new Error(`REGISTERED_EFFECT_DISPATCH_NOT_ADMITTED:${capabilities.effect_contract}`);
}
