import { execFileSync } from 'node:child_process';

import { GITHUB_API_VERSION } from './contract.ts';

export type GithubJsonGet=(token:string,path:string)=>unknown;

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

export function githubRepositoryFullNameKey(fullName:string):string {
  return fullName.toLowerCase();
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
