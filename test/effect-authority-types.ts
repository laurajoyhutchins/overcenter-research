import {GITHUB_COMMIT_STATUS_EFFECT} from '../src/effect-adapter.ts';
import type {EffectAuthority,KernelCore} from '../src/authority/engine.ts';
import type {
  ExecutionPermit,
  GitHubCommitStatusPostcondition,
} from '../src/model.ts';

type StatusAuthority=EffectAuthority<
  typeof GITHUB_COMMIT_STATUS_EFFECT,
  GitHubCommitStatusPostcondition['verifier']
>;

declare const kernel:KernelCore;
declare const permit:ExecutionPermit;
declare const postcondition:GitHubCommitStatusPostcondition;
declare const authority:StatusAuthority;

void kernel.performEffect(authority,async()=>42);

// @ts-expect-error raw execution authority is weaker than a bound effect authority
void kernel.performEffect(permit,async()=>42);

// @ts-expect-error the private unique-symbol brand cannot be structurally forged
const forged:StatusAuthority={permit,postcondition};
void forged;
