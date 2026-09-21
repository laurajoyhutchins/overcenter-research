import { execFileSync } from 'node:child_process';

import { GITHUB_API_VERSION } from './github-contract.ts';

export type GithubJsonGet=(token:string,path:string)=>unknown;
export type GithubJsonGetAsync=(token:string,path:string)=>unknown|Promise<unknown>;

const GITHUB_OBJECT_ID=/^[0-9a-f]{40,64}$/i;

export function isGithubObjectId(value:unknown):value is string {
  return typeof value==='string' && GITHUB_OBJECT_ID.test(value);
}

export function sameGithubObjectId(left:string,right:string):boolean {
  return left.toLowerCase()===right.toLowerCase();
}

export function githubStatusContextKey(context:string):string {
  return context.toLowerCase();
}

export function githubGet(token:string,path:string):unknown {
  const config=[
    `header = "Authorization: Bearer ${token}"`,
    'header = "Accept: application/vnd.github+json"',
    `header = "X-GitHub-Api-Version: ${GITHUB_API_VERSION}"`,
    '',
  ].join('\n');
  try {
    const stdout=execFileSync(
      'curl',
      ['--silent','--show-error','--fail-with-body','--config','-',`https://api.github.com${path}`],
      {input:config,encoding:'utf8',stdio:['pipe','pipe','pipe']},
    );
    return JSON.parse(stdout);
  } catch (error:unknown) {
    const failure=error as {
      stderr?:string|Buffer;
      stdout?:string|Buffer;
      message?:string;
    };
    throw new Error(
      `GITHUB_PROVIDER_READ_FAILED: ${String(
        failure.stderr??failure.stdout??failure.message??'',
      ).trim()}`,
    );
  }
}

export async function githubGetAsync(token:string,path:string):Promise<unknown> {
  const response=await fetch(`https://api.github.com${path}`,{
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':GITHUB_API_VERSION,
    },
  });
  const body=await response.text();
  if (!response.ok) {
    throw new Error(
      `GITHUB_PROVIDER_READ_FAILED: ${response.status} ${body}`.trim(),
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('GITHUB_PROVIDER_READ_INVALID_JSON');
  }
}


class GithubAsyncReadRequired {
  constructor(readonly path:string) {}
}

export async function runGithubReadObserverAsync<T>(
  token:string,
  observe:(get:GithubJsonGet)=>T,
  get:GithubJsonGetAsync=githubGetAsync,
):Promise<T> {
  const cache=new Map<string,unknown>();
  for (let reads=0;reads<256;) {
    try {
      return observe((readToken,path)=>{
        if (readToken!==token) throw new Error('GITHUB_PROVIDER_TOKEN_MISMATCH');
        if (cache.has(path)) return cache.get(path);
        throw new GithubAsyncReadRequired(path);
      });
    } catch (error:unknown) {
      if (!(error instanceof GithubAsyncReadRequired)) throw error;
      if (reads++>=255) throw new Error('GITHUB_PROVIDER_READ_LIMIT_EXCEEDED');
      cache.set(error.path,await get(token,error.path));
    }
  }
  throw new Error('GITHUB_PROVIDER_READ_LIMIT_EXCEEDED');
}
