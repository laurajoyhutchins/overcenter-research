import { execFileSync } from 'node:child_process';

export function githubStatusContextKey(context: string): string {
  return context.toLowerCase();
}

export function githubGet(token: string, path: string): unknown {
  const config = [
    `header = "Authorization: Bearer ${token}"`,
    'header = "Accept: application/vnd.github+json"',
    'header = "X-GitHub-Api-Version: 2026-03-10"',
    '',
  ].join('\n');
  try {
    const stdout=execFileSync(
      'curl',
      ['--silent','--show-error','--fail-with-body','--config','-',`https://api.github.com${path}`],
      {input:config,encoding:'utf8',stdio:['pipe','pipe','pipe']},
    );
    return JSON.parse(stdout);
  } catch (e: unknown) {
    const f=e as {stderr?:string|Buffer;stdout?:string|Buffer;message?:string};
    throw new Error(`GITHUB_PROVIDER_READ_FAILED: ${String(f.stderr??f.stdout??f.message??'').trim()}`);
  }
}

export function findGithubCommitStatus(
  token: string,
  repositoryFullName: string,
  commitSha: string,
  context: string,
): { context?: string; state?: string } | null {
  const target=githubStatusContextKey(context);
  for (let page=1; page<=1000; page+=1) {
    const statuses=githubGet(
      token,
      `/repos/${repositoryFullName}/commits/${commitSha}/statuses?per_page=100&page=${page}`,
    );
    if (!Array.isArray(statuses)) throw new Error('GITHUB_STATUS_RESPONSE_INVALID');
    const typed=statuses as Array<{ context?: string; state?: string }>;
    const match=typed.find(candidate=>
      typeof candidate.context==='string'
      && githubStatusContextKey(candidate.context)===target
    );
    if (match) return match;
    if (typed.length<100) return null;
  }
  throw new Error('GITHUB_STATUS_PAGINATION_EXHAUSTED');
}
