import type { KernelCore } from '../kernel-core.ts';
import type { ExecutionPermit } from '../model.ts';
import { GITHUB_API_VERSION } from './github-contract.ts';
import { observeCertifiedGithubRepository } from './github-certified-repository.ts';
import { githubGet, type GithubJsonGet } from './github-rest.ts';

export const GITHUB_COMMIT_STATUS_EFFECT =
  'github-commit-status/set-from-postcondition/v1' as const;

export interface GithubStatusMutationBody {
  state:'error'|'failure'|'pending'|'success';
  context:string;
  description:string;
}

export type GithubStatusPost=(
  token:string,
  path:string,
  body:GithubStatusMutationBody,
)=>Promise<{status:number;body:string}>;

async function githubPost(
  token:string,
  path:string,
  body:GithubStatusMutationBody,
):Promise<{status:number;body:string}> {
  const response=await fetch(`https://api.github.com${path}`,{
    method:'POST',
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':GITHUB_API_VERSION,
      'Content-Type':'application/json',
    },
    body:JSON.stringify(body),
  });
  return {status:response.status,body:await response.text()};
}

export async function performGithubCommitStatusEffect(
  kernel:KernelCore,
  permit:ExecutionPermit,
  {
    token,
    get=githubGet,
    post=githubPost,
    clock=()=>new Date().toISOString(),
  }:{
    token:string;
    get?:GithubJsonGet;
    post?:GithubStatusPost;
    clock?:()=>string;
  },
):Promise<{
  repository_id:number;
  repository_full_name:string;
  commit_sha:string;
  context:string;
  state:'error'|'failure'|'pending'|'success';
}> {
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');

  const work=kernel.claimedWork(permit.id);
  if (
    work.id!==permit.obligation_id
    || work.run_id!==permit.id
    || work.claimed_revision!==permit.claimed_revision
  ) {
    throw new Error('GITHUB_STATUS_EFFECT_RUN_MISMATCH');
  }
  if (work.packet.effect_contract!==GITHUB_COMMIT_STATUS_EFFECT) {
    throw new Error('GITHUB_STATUS_EFFECT_NOT_AUTHORIZED');
  }
  if (work.postcondition.verifier!=='github-commit-status/v2') {
    throw new Error('GITHUB_STATUS_EFFECT_POSTCONDITION_MISMATCH');
  }

  const p=work.postcondition;
  const repository=observeCertifiedGithubRepository(token,{
    repositoryId:p.repository_id,
    repositoryFullName:p.repository_full_name,
    get,
    clock,
    observerId:'github-commit-status-effect/v1',
  });
  const {owner,repo,full_name}=repository.fact.object;
  const path=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(p.commit_sha)}`;
  const body:GithubStatusMutationBody={
    state:p.expected_state,
    context:p.context,
    description:'Overcenter trusted effect broker',
  };

  return kernel.performEffect(permit,async()=>{
    const response=await post(token,path,body);
    if (response.status!==201) {
      throw new Error(
        `GITHUB_STATUS_MUTATION_FAILED:${response.status}:${response.body}`,
      );
    }
    return {
      repository_id:p.repository_id,
      repository_full_name:full_name,
      commit_sha:p.commit_sha,
      context:p.context,
      state:p.expected_state,
    };
  });
}
