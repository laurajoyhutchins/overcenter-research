import { GitFactStore } from './git-store.ts';
import {
  KernelCore,
  runCoreLoop,
  type KernelOptions,
} from './kernel-core.ts';

export type { Receipt } from './kernel-core.ts';

const STATE_REF='refs/overcenter/state';

export interface GitKernelOptions extends KernelOptions {
  ref?:string;
  remote?:string|null;
}

export class GitOvercenterKernel extends KernelCore {
  readonly repo:string;
  readonly ref:string;
  readonly remote:string|null;

  constructor(
    repo:string,
    {
      ref=STATE_REF,
      remote=null,
      githubToken=null,
      observationContext={},
    }:GitKernelOptions={},
  ) {
    const store=new GitFactStore(repo,{ref,remote});
    super(store,{githubToken,observationContext});
    this.repo=repo;
    this.ref=ref;
    this.remote=remote;
  }
}

export const runGitCoreLoop=runCoreLoop;
