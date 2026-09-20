import { githubProofStateRef } from '../proof-environment.ts';
import { appendFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

const STATE_REF=githubProofStateRef('two-effect-concurrency');

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
const sourceSha=required('GITHUB_SHA');
const info=await github(`/repos/${repository}`);
if (!Number.isSafeInteger(info.id)) throw new Error('REPOSITORY_ID_UNAVAILABLE');

const kernel=new GitOvercenterKernel(process.cwd(),{remote:'origin',ref:STATE_REF});
kernel.initialize();

for (const slot of ['alpha','beta']) {
  const id=`concurrency-${workflowRunId}-${attempt}-${slot}`;
  const context=`overcenter/concurrency/${workflowRunId}/${attempt}/${slot}`;
  kernel.define({
    id,
    packet:{
      kind:'github-actions-two-effect-proof/v1',
      executor:{
        provider:'github-actions/v1',
        repository_id:info.id,
        workflow_run_id:workflowRunId,
        workflow_run_attempt:attempt,
        slot,
      },
      exact_input:{
        kind:'git-commit/v1',
        repository_id:info.id,
        commit_sha:sourceSha,
      },
      effect_contract:'github-commit-status/set-from-postcondition/v1',
    },
    postcondition:{
      verifier:'github-commit-status/v2',
      provider:'github',
      repository_id:info.id,
      repository_full_name:repository,
      commit_sha:sourceSha,
      context,
      expected_state:'success',
    },
  });
}

const claims=[];
for (const slot of ['alpha','beta']) {
  const id=`concurrency-${workflowRunId}-${attempt}-${slot}`;
  const work=kernel.inspect().find(candidate=>candidate.id===id);
  if (!work) throw new Error(`MISSING_${slot.toUpperCase()}`);
  const run=kernel.claim(id,work.revision);
  claims.push({slot,run});
}

const state=kernel.inspect().filter(work=>work.id.startsWith(`concurrency-${workflowRunId}-${attempt}-`));
if (state.length!==2 || state.some(work=>work.status!=='EXECUTING')) {
  throw new Error(`EXPECTED_TWO_EXECUTING: ${JSON.stringify(state)}`);
}

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) appendFileSync(summary,[
  '## Trusted two-effect authority',
  '',
  `- State ref: \`${STATE_REF}\``,
  `- Exact input: \`${sourceSha}\``,
  ...claims.map(({slot,run})=>`- ${slot}: run \`${run.id}\`, claim \`${run.claim_commit}\``),
  '- Both obligations are EXECUTING simultaneously before either disposable agent starts.',
  '',
].join('\n'));

console.log(JSON.stringify({state_ref:STATE_REF,claims}));
