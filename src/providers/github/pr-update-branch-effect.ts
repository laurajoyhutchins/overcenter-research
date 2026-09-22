import type { KernelCore } from '../kernel-core.ts';
import type { ExecutionPermit } from '../model.ts';
import { GITHUB_API_VERSION } from './github-contract.ts';
import { observeCertifiedGithubPullRequestIdentity } from './github-certified-pr.ts';
import { githubGetAsync, runGithubReadObserverAsync, type GithubJsonGetAsync } from './github-rest.ts';

export const GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT =
  'github-pull-request/update-branch' as const;

export type GithubUpdateBranchPut=(
  token:string,
  path:string,
  body:{expected_head_sha:string},
)=>Promise<{status:number;body:string}>;

async function githubPut(
  token:string,
  path:string,
  body:{expected_head_sha:string},
):Promise<{status:number;body:string}> {
  const response=await fetch(`https://api.github.com${path}`,{
    method:'PUT',
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

export async function performGithubPullRequestUpdateBranchEffect(
  kernel:KernelCore,
  permit:ExecutionPermit,
  {
    token,
    get=githubGetAsync,
    put=githubPut,
    clock=()=>new Date().toISOString(),
  }:{
    token:string;
    get?:GithubJsonGetAsync;
    put?:GithubUpdateBranchPut;
    clock?:()=>string;
  },
):Promise<{repository_id:number;repository_full_name:string;pull_number:number;previous_head_sha:string}> {
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');
  const work=kernel.claimedWork(permit.id);
  if (work.id!==permit.obligation_id || work.run_id!==permit.id || work.claimed_revision!==permit.claimed_revision) {
    throw new Error('GITHUB_PR_UPDATE_BRANCH_RUN_MISMATCH');
  }
  if (work.packet.effect_contract!==GITHUB_PULL_REQUEST_UPDATE_BRANCH_EFFECT) {
    throw new Error('GITHUB_PR_UPDATE_BRANCH_EFFECT_NOT_AUTHORIZED');
  }
  if (work.postcondition.verifier!=='github-pull-request-branch-updated/v1') {
    throw new Error('GITHUB_PR_UPDATE_BRANCH_POSTCONDITION_MISMATCH');
  }
  const p=work.postcondition;
  const identity=await runGithubReadObserverAsync(
    token,
    syncGet=>observeCertifiedGithubPullRequestIdentity(token,{
      repositoryId:p.repository_id,
      repositoryFullName:p.repository_full_name,
      pullNumber:p.pull_number,
      expected:{
        node_id:p.pull_node_id,
        state:'open',
        head_sha:p.expected_previous_head_sha,
        base_ref:p.base_ref,
        base_sha:p.expected_base_sha,
      },
      get:syncGet,
      clock,
    }),
    get,
  );
  if (identity.state!=='CURRENT' || !identity.repository_full_name) {
    throw new Error(`GITHUB_PR_UPDATE_BRANCH_IDENTITY_NOT_CURRENT:${identity.reason}`);
  }
  const [owner,repo]=identity.repository_full_name.split('/');
  if (!owner || !repo) throw new Error('GITHUB_PR_UPDATE_BRANCH_REPOSITORY_INVALID');
  const path=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${p.pull_number}/update-branch`;

  return kernel.performEffect(permit,async()=>{
    const response=await put(token,path,{expected_head_sha:p.expected_previous_head_sha});
    if (response.status!==202) {
      throw new Error(`GITHUB_PR_UPDATE_BRANCH_FAILED:${response.status}:${response.body}`);
    }
    return {
      repository_id:p.repository_id,
      repository_full_name:identity.repository_full_name!,
      pull_number:p.pull_number,
      previous_head_sha:p.expected_previous_head_sha,
    };
  });
}
