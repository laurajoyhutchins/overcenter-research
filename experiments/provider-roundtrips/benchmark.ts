import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { GITHUB_API_VERSION } from '../../src/providers/github-contract.ts';
import { observeCertifiedGithubRepository } from '../../src/providers/github-certified-repository.ts';
import { observeCertifiedGithubCommitStatus } from '../../src/providers/github-certified-status.ts';
import { githubGet } from '../../src/providers/github-rest.ts';
import { assertCombinedStatus } from './combined-status.ts';

type Variant='baseline'|'candidate';
type Sample={
  variant:Variant;
  identity_ms:number;
  mutation_ms:number;
  readback_ms:number;
  total_ms:number;
};

const required=(name:string):string=>{
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const round=(n:number)=>Math.round(n*1000)/1000;
const stats=(values:number[])=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return {min:round(sorted[0]),median:round(sorted[Math.floor(sorted.length/2)]),max:round(sorted.at(-1)!)};
};

async function fetchJson(token:string,path:string,init:RequestInit={}):Promise<unknown> {
  const response=await fetch(`https://api.github.com${path}`,{
    ...init,
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':GITHUB_API_VERSION,
      ...(init.headers??{}),
    },
  });
  const text=await response.text();
  if (!response.ok) throw new Error(`GITHUB_FETCH_FAILED:${response.status}:${text}`);
  return JSON.parse(text);
}

async function postStatus(token:string,path:string,context:string):Promise<void> {
  const response=await fetch(`https://api.github.com${path}`,{
    method:'POST',
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':GITHUB_API_VERSION,
      'Content-Type':'application/json',
    },
    body:JSON.stringify({
      state:'success',
      context,
      description:'Overcenter provider round-trip experiment',
    }),
  });
  const body=await response.text();
  if (response.status!==201) throw new Error(`GITHUB_STATUS_MUTATION_FAILED:${response.status}:${body}`);
}

function assertCandidateRepository(value:unknown,repositoryId:number,repositoryFullName:string):void {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('CANDIDATE_REPOSITORY_INVALID');
  const v=value as Record<string,unknown>;
  if (v.id!==repositoryId) throw new Error('CANDIDATE_REPOSITORY_ID_MISMATCH');
  if (typeof v.full_name!=='string' || v.full_name.toLowerCase()!==repositoryFullName.toLowerCase()) {
    throw new Error('CANDIDATE_REPOSITORY_NAME_MISMATCH');
  }
}

async function runBaseline(args:{
  token:string;
  repositoryId:number;
  repositoryFullName:string;
  commitSha:string;
  context:string;
}):Promise<Sample> {
  const [owner,repo]=args.repositoryFullName.split('/');
  const total=performance.now();

  const identity=performance.now();
  observeCertifiedGithubRepository(args.token,{
    repositoryId:args.repositoryId,
    repositoryFullName:args.repositoryFullName,
    get:githubGet,
    observerId:'provider-roundtrips/baseline',
  });
  const identityMs=performance.now()-identity;

  const mutation=performance.now();
  await postStatus(
    args.token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(args.commitSha)}`,
    args.context,
  );
  const mutationMs=performance.now()-mutation;

  const readback=performance.now();
  const observed=observeCertifiedGithubCommitStatus(args.token,{
    repositoryId:args.repositoryId,
    repositoryFullName:args.repositoryFullName,
    commitSha:args.commitSha,
    context:args.context,
    get:githubGet,
  });
  assert.equal(observed.state,'present');
  assert.equal(observed.actual_state,'success');
  const readbackMs=performance.now()-readback;

  return {
    variant:'baseline',
    identity_ms:round(identityMs),
    mutation_ms:round(mutationMs),
    readback_ms:round(readbackMs),
    total_ms:round(performance.now()-total),
  };
}

async function runCandidate(args:{
  token:string;
  repositoryId:number;
  repositoryFullName:string;
  commitSha:string;
  context:string;
}):Promise<Sample> {
  const [owner,repo]=args.repositoryFullName.split('/');
  const total=performance.now();

  const identity=performance.now();
  assertCandidateRepository(
    await fetchJson(args.token,`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`),
    args.repositoryId,
    args.repositoryFullName,
  );
  const identityMs=performance.now()-identity;

  const mutation=performance.now();
  await postStatus(
    args.token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(args.commitSha)}`,
    args.context,
  );
  const mutationMs=performance.now()-mutation;

  const readback=performance.now();
  const combined=await fetchJson(
    args.token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(args.commitSha)}/status?per_page=100&page=1`,
  );
  assertCombinedStatus(combined,{
    repositoryId:args.repositoryId,
    repositoryFullName:args.repositoryFullName,
    commitSha:args.commitSha,
    context:args.context,
    state:'success',
  });
  const readbackMs=performance.now()-readback;

  return {
    variant:'candidate',
    identity_ms:round(identityMs),
    mutation_ms:round(mutationMs),
    readback_ms:round(readbackMs),
    total_ms:round(performance.now()-total),
  };
}

const token=required('GITHUB_TOKEN');
const repositoryId=Number(required('REPOSITORY_ID'));
const repositoryFullName=required('GITHUB_REPOSITORY');
const commitSha=required('SOURCE_SHA');
const runId=required('GITHUB_RUN_ID');
const iterations=Number(process.env.ITERATIONS??'4');
if (!Number.isSafeInteger(repositoryId) || repositoryId<1) throw new Error('INVALID_REPOSITORY_ID');
if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) throw new Error('INVALID_SOURCE_SHA');
if (!Number.isSafeInteger(iterations) || iterations<2 || iterations>10) throw new Error('INVALID_ITERATIONS');

const samples:Sample[]=[];
for (let i=0;i<iterations;i+=1) {
  const order:Variant[]=i%2===0?['baseline','candidate']:['candidate','baseline'];
  for (const variant of order) {
    const context=`overcenter/provider-roundtrips/${runId}/${i}/${variant}`;
    const args={token,repositoryId,repositoryFullName,commitSha,context};
    samples.push(variant==='baseline'?await runBaseline(args):await runCandidate(args));
  }
}

const summarize=(variant:Variant)=>{
  const selected=samples.filter(sample=>sample.variant===variant);
  return Object.fromEntries(
    (['identity_ms','mutation_ms','readback_ms','total_ms'] as const)
      .map(metric=>[metric,stats(selected.map(sample=>sample[metric]))]),
  );
};
const baseline=summarize('baseline');
const candidate=summarize('candidate');
const improvement=round(
  100*(baseline.total_ms.median-candidate.total_ms.median)/baseline.total_ms.median,
);

const result={iterations,samples,summary:{baseline,candidate,median_total_improvement_percent:improvement}};
console.log(JSON.stringify(result,null,2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const fs=await import('node:fs');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,[
    '# Provider round-trip comparison',
    '',
    `Paired samples per variant: **${iterations}**`,
    '',
    '| Variant | identity median ms | mutation median ms | readback median ms | total median ms |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| current production pattern | ${baseline.identity_ms.median} | ${baseline.mutation_ms.median} | ${baseline.readback_ms.median} | ${baseline.total_ms.median} |`,
    `| persistent fetch + combined readback | ${candidate.identity_ms.median} | ${candidate.mutation_ms.median} | ${candidate.readback_ms.median} | ${candidate.total_ms.median} |`,
    '',
    `Median total improvement: **${improvement}%**`,
    '',
  ].join('\n'));
}
