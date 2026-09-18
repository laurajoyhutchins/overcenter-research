import { GitOvercenterKernel } from '../../src/git-kernel.ts';

const STATE_REF='refs/overcenter/conflict-state';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function github(path:string):Promise<any> {
  const token=required('GITHUB_TOKEN');
  const response=await fetch(`https://api.github.com${path}`,{
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${await response.text()}`);
  return response.json();
}

const repository=required('GITHUB_REPOSITORY');
const workflowRunId=required('GITHUB_RUN_ID');
const attempt=required('GITHUB_RUN_ATTEMPT');
const sha=required('GITHUB_SHA');
const info=await github(`/repos/${repository}`);
const context=`overcenter/conflict/${workflowRunId}/${attempt}`;

const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:STATE_REF});
kernel.initialize();

for (const [slot,expected] of [['alpha','success'],['beta','failure']] as const) {
  kernel.define({
    id:`conflict-${workflowRunId}-${attempt}-${slot}`,
    packet:{slot,expected},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:info.id,
      commit_sha:sha,
      context,
      expected_state:expected,
    },
  });
}

for (const slot of ['alpha','beta']) {
  const work=kernel.inspect().find(candidate=>candidate.id.endsWith(`-${slot}`));
  if (!work) throw new Error(`MISSING_${slot}`);
  kernel.claim(work.id,work.revision);
}

const executing=kernel.inspect().filter(work=>work.id.startsWith(`conflict-${workflowRunId}-${attempt}-`));
if (executing.length!==2 || executing.some(work=>work.status!=='EXECUTING')) {
  throw new Error(`EXPECTED_TWO_EXECUTING: ${JSON.stringify(executing)}`);
}
console.log(JSON.stringify({context,executing:executing.map(work=>({id:work.id,run_id:work.run_id,postcondition:work.postcondition}))}));
