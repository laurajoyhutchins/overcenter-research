// @ts-expect-error raw GitHub status transport is intentionally not exported.
import { createGithubStatusPost } from '../src/providers/github/status-effect.ts';

import type { EffectAuthority, KernelCore } from '../src/authority/engine.ts';
import { GITHUB_COMMIT_STATUS_EFFECT } from '../src/effect-adapter.ts';
import type { ExecutionPermit } from '../src/model.ts';
import { performGithubCommitStatusEffect } from '../src/providers/github/status-effect.ts';

declare const kernel: KernelCore;
declare const permit: ExecutionPermit;
declare const options: Parameters<typeof performGithubCommitStatusEffect>[2];
declare const structural: Pick<
  EffectAuthority<typeof GITHUB_COMMIT_STATUS_EFFECT, 'github-commit-status/v2'>,
  'postcondition'
>;

// @ts-expect-error effect reservation is private to KernelCore.
kernel.beginEffect(permit);

// @ts-expect-error provider mutation requires EffectAuthority, never a raw ExecutionPermit.
void performGithubCommitStatusEffect(kernel, permit, options);

// @ts-expect-error the private brand prevents structural construction of EffectAuthority.
const forged: EffectAuthority<typeof GITHUB_COMMIT_STATUS_EFFECT, 'github-commit-status/v2'> =
  structural;

void createGithubStatusPost;
void forged;
