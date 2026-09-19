import { appendFileSync, writeFileSync } from 'node:fs';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { githubProofStateRef } from '../proof-environment.ts';
import { canonicalDigest } from '../../src/digest.ts';
import { bindTaskSession } from '../../src/effect-broker.ts';
import { githubCommitStatusEffectAuthority } from '../../src/provider-effect.ts';

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
const expectedResult={
  kind:'provider-capability-confinement-result/v1',
  source_sha:sourceSha,
  authorized_write_status:403,
  forged_write_status:403,
};

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
  effect_authority:githubCommitStatusEffectAuthority(),
  result_acceptance:{
    verifier:'canonical-json-sha256/v1',
    expected_sha256:canonicalDigest(expectedResult),
  },
});

const work=kernel.inspect().find(candidate=>candidate.id===obligationId);
if (!work) throw new Error('CAPABILITY_OBLIGATION_MISSING');
kernel.claim(work.id,work.revision);
const claimed=kernel.inspect().find(candidate=>candidate.id===obligationId);
if (!claimed) throw new Error('CLAIMED_WORK_MISSING');
const session=bindTaskSession(claimed);
writeFileSync('task-session.json',JSON.stringify(session,null,2)+'\n');

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary,[
    '## Capability authority',
    '',
    '- Obligation: '+obligationId,
    '- Exact source: '+sourceSha,
    '- Authorized status context: '+context,
    '- Run: '+session.run_id,
    '- TaskSession was bound at dispatch generation 1 before worker execution.',
    '- Effect authority and result acceptance are explicit immutable obligation fields.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify({
  obligation_id:obligationId,
  repository_id:repositoryInfo.id,
  context,
  session,
  expected_result_sha256:canonicalDigest(expectedResult),
}));
