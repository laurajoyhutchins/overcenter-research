import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import type {
  GitHubCommitStatusPostconditionV2,
  Observation,
} from '../../src/model.ts';
import {
  observationVerified,
  observePostcondition,
} from '../../src/observation.ts';
import { settlementEquivalenceWitness } from '../../src/semantics.ts';
import { GITHUB_API_VERSION } from '../../src/providers/github-contract.ts';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const token=required('GITHUB_TOKEN');
const repository=required('GITHUB_REPOSITORY');
const sha=required('SOURCE_SHA');
const runId=required('GITHUB_RUN_ID');
const runAttempt=required('GITHUB_RUN_ATTEMPT');

async function github(
  path:string,
  init:RequestInit={},
):Promise<Response> {
  return fetch(`https://api.github.com${path}`,{
    ...init,
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':GITHUB_API_VERSION,
      'Content-Type':'application/json',
      ...(init.headers??{}),
    },
  });
}

interface RawStatus {
  id:number;
  state:'error'|'failure'|'pending'|'success';
  context:string;
  description:string|null;
  target_url:string|null;
  created_at:string;
  updated_at:string;
}

const repositoryResponse=await github(`/repos/${repository}`);
assert.equal(repositoryResponse.status,200);
const repositoryIdentity=await repositoryResponse.json() as {
  id:number;
  full_name:string;
};
assert.equal(repositoryIdentity.full_name.toLowerCase(),repository.toLowerCase());

function postcondition(
  context:string,
  expected_state:'error'|'failure'|'pending'|'success'='success',
):GitHubCommitStatusPostconditionV2 {
  return {
    verifier:'github-commit-status/v2',
    provider:'github',
    repository_id:repositoryIdentity.id,
    repository_full_name:repositoryIdentity.full_name,
    commit_sha:sha,
    context,
    expected_state,
  };
}

function payload(
  context:string,
  state:'error'|'failure'|'pending'|'success',
  label:string,
) {
  return {
    state,
    context,
    description:`Overcenter settlement-equivalence ${label}`,
    target_url:`https://github.com/${repository}/actions/runs/${runId}#${encodeURIComponent(label)}`,
  };
}

async function writeStatus(
  context:string,
  state:'error'|'failure'|'pending'|'success',
  label:string,
):Promise<RawStatus> {
  const response=await github(
    `/repos/${repository}/statuses/${sha}`,
    {
      method:'POST',
      body:JSON.stringify(payload(context,state,label)),
    },
  );
  assert.equal(
    response.status,
    201,
    `status write ${label} failed: ${await response.text()}`,
  );
  return await response.json() as RawStatus;
}

async function listStatuses():Promise<RawStatus[]> {
  const response=await github(
    `/repos/${repository}/commits/${sha}/statuses?per_page=100`,
  );
  assert.equal(response.status,200);
  return await response.json() as RawStatus[];
}

async function waitForContext(
  context:string,
  minimum:number,
):Promise<RawStatus[]> {
  for (let attempt=0;attempt<10;attempt+=1) {
    const statuses=(await listStatuses())
      .filter(status=>status.context.toLowerCase()===context.toLowerCase());
    if (statuses.length>=minimum) return statuses;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error(`PROVIDER_RECORDS_NOT_VISIBLE:${context}`);
}

function productionObservation(
  condition:GitHubCommitStatusPostconditionV2,
):Observation {
  return observePostcondition(condition,{githubToken:token});
}

function truth(
  condition:GitHubCommitStatusPostconditionV2,
  observed:Observation,
) {
  return {
    mutation_certainty:observed.mutation_certainty,
    actual_state:observed.actual_state,
    verified:observationVerified(condition,observed),
  };
}

function assertPhysicallyDistinct(
  records:RawStatus[],
  labels:string[],
):void {
  const selected=records.filter(record=>
    labels.some(label=>record.description===
      `Overcenter settlement-equivalence ${label}`),
  );
  assert.ok(selected.length>=labels.length);
  assert.equal(new Set(selected.map(record=>record.id)).size>=labels.length,true);
  assert.equal(
    new Set(selected.map(record=>record.description)).size>=labels.length,
    true,
  );
  assert.equal(
    new Set(selected.map(record=>record.target_url)).size>=labels.length,
    true,
  );
}

const prefix=`overcenter/settlement-equivalence/${runId}/${runAttempt}`;

async function sameStateScenario(
  name:string,
  mode:'ab'|'ba'|'parallel',
) {
  const context=`${prefix}/${name}`;
  const A=()=>writeStatus(context,'success',`${name}-A`);
  const B=()=>writeStatus(context,'success',`${name}-B`);

  if (mode==='ab') {
    await A();
    await B();
  } else if (mode==='ba') {
    await B();
    await A();
  } else {
    await Promise.all([A(),B()]);
  }

  const records=await waitForContext(context,2);
  assertPhysicallyDistinct(records,[`${name}-A`,`${name}-B`]);
  assert.ok(records.every(record=>
    record.context.toLowerCase()!==context.toLowerCase()
    || record.state==='success',
  ));

  const condition=postcondition(context,'success');
  const witness=settlementEquivalenceWitness(condition);
  assert.ok(witness);
  assert.equal(
    witness.equivalence_class,
    'same-project-truth-under-observation-and-settlement',
  );

  const observed=productionObservation(condition);
  const derived=truth(condition,observed);
  assert.deepEqual(derived,{
    mutation_certainty:'present',
    actual_state:'success',
    verified:true,
  });

  return {context,derived,records:records.length};
}

async function mixedStateScenario(
  name:string,
  order:['success','failure']|['failure','success'],
) {
  const context=`${prefix}/${name}`;
  await writeStatus(context,order[0],`${name}-first-${order[0]}`);
  await writeStatus(context,order[1],`${name}-second-${order[1]}`);

  const records=await waitForContext(context,2);
  assert.equal(records[0]?.state,order[1]);

  const condition=postcondition(context,'success');
  const observed=productionObservation(condition);
  return {
    context,
    order,
    truth:truth(condition,observed),
  };
}

const ab=await sameStateScenario('same-ab','ab');
const ba=await sameStateScenario('same-ba','ba');
const parallel=await sameStateScenario('same-parallel','parallel');

assert.deepEqual(ab.derived,ba.derived);
assert.deepEqual(ab.derived,parallel.derived);

const successThenFailure=await mixedStateScenario(
  'mixed-success-failure',
  ['success','failure'],
);
const failureThenSuccess=await mixedStateScenario(
  'mixed-failure-success',
  ['failure','success'],
);

assert.deepEqual(successThenFailure.truth,{
  mutation_certainty:'present',
  actual_state:'failure',
  verified:false,
});
assert.deepEqual(failureThenSuccess.truth,{
  mutation_certainty:'present',
  actual_state:'success',
  verified:true,
});
assert.notDeepEqual(
  successThenFailure.truth,
  failureThenSuccess.truth,
  'mixed desired states must remain order-sensitive',
);

const result={
  repository_id:repositoryIdentity.id,
  repository_full_name:repositoryIdentity.full_name,
  commit_sha:sha,
  same_state:{
    ab,
    ba,
    parallel,
  },
  mixed_state:{
    success_then_failure:successThenFailure,
    failure_then_success:failureThenSuccess,
  },
};

const summary=process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary,[
    '## GitHub settlement-equivalence proof',
    '',
    `- Exact source revision: \`${sha}\``,
    '- Same-state A→B: verified project truth = success.',
    '- Same-state B→A: verified project truth = success.',
    '- Same-state A∥B: verified project truth = success.',
    '- Each same-state scenario left distinct provider records with distinct descriptions and target URLs.',
    '- Mixed success→failure: expected-success postcondition did not verify.',
    '- Mixed failure→success: expected-success postcondition verified.',
    '',
    'The positive claim is settlement equivalence, not physical-history identity.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify(result,null,2));
