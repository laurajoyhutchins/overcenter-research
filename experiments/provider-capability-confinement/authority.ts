import { appendFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { githubProofStateRef } from '../proof-environment.ts';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error('missing '+name);
  return value;
}

async function github(path:string):Promise<any> {
  const token=required('GITHUB_TOKEN');
  const response=await fetch('https://api.github.com'+path,{
    headers:{
      Authorization:'Bearer '+token,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
    },
  });
  if (!response.ok) throw new Error('GitHub '+response.status+': '+await response.text());
  return response.json();
}

const repository=required('GITHUB_REPOSITORY');
const runId=required('GITHUB_RUN_ID');
const attempt=required('GITHUB_RUN_ATTEMPT');
const sourceSha=required('SOURCE_SHA');
const stateRef=githubProofStateRef('provider-capability-confinement');

const repositoryInfo=await github('/repos/'+repository);
if (!Number.isSafeInteger(repositoryInfo.id)) throw new Error('REPOSITORY_ID_UNAVAILABLE');

const obligationId='provider-capability-confinement-'+runId+'-'+attempt;
const context='overcenter/capability-confinement/'+runId+'/'+attempt;

const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:stateRef});
kernel.initialize();
kernel.define({
  id:obligationId,
  packet:{
    kind:'provider-capability-confinement/v1',
    executor:{
      provider:'github-actions/v1',
      repository_id:repositoryInfo.id,
      workflow_run_id:runId,
      workflow_run_attempt:attempt,
      job:'hostile-worker',
    },
    exact_input:{
      kind:'git-commit/v1',
      repository_id:repositoryInfo.id,
      commit_sha:sourceSha,
    },
  },
  postcondition:{
    verifier:'github-commit-status/v1',
    provider:'github',
    repository_id:repositoryInfo.id,
    commit_sha:sourceSha,
    context,
    expected_state:'success',
  },
});

const work=kernel.inspect().find(candidate=>candidate.id===obligationId);
if (!work) throw new Error('CAPABILITY_OBLIGATION_MISSING');
const claim=kernel.claim(work.id,work.revision);

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary,[
    '## Capability authority',
    '',
    '- Obligation: '+obligationId,
    '- Exact source: '+sourceSha,
    '- Authorized status context: '+context,
    '- Run: '+claim.id,
    '- Worker starts at generation 1 but receives no execution capability secret and no provider write permission.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  obligation_id:obligationId,
  repository_id:repositoryInfo.id,
  context,
  run_id:claim.id,
  claimed_revision:claim.claimed_revision,
}));
