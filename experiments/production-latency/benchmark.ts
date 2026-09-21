import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { OvercenterKernel } from '../../src/kernel.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  performGithubCommitStatusEffect,
  type GithubStatusPost,
} from '../../src/providers/github-status-effect.ts';
import {
  githubGet,
  type GithubJsonGet,
} from '../../src/providers/github-rest.ts';

type Mode='mock'|'live';
type Phase='idle'|'effect'|'settlement';

class TimedKernel extends OvercenterKernel {
  reservationMs=0;
  effectBoundaryMs=0;

  override async performEffect<T>(permit:Parameters<OvercenterKernel['performEffect']>[0],effect:()=>Promise<T>|T):Promise<T> {
    const started=performance.now();
    return super.performEffect(permit,async()=>{
      this.reservationMs+=performance.now()-started;
      const effectStarted=performance.now();
      try {
        return await effect();
      } finally {
        this.effectBoundaryMs+=performance.now()-effectStarted;
      }
    });
  }
}

interface Sample {
  authority_ms:number;
  provider_identity_ms:number;
  effect_reservation_ms:number;
  mutation_boundary_ms:number;
  effect_local_ms:number;
  readback_ms:number;
  settlement_local_ms:number;
  overcenter_local_ms:number;
  provider_ms:number;
  total_ms:number;
}

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function round(value:number):number {
  return Math.round(value*1000)/1000;
}

function stats(values:number[]) {
  const sorted=[...values].sort((a,b)=>a-b);
  const median=sorted[Math.floor(sorted.length/2)];
  return {
    min:round(sorted[0]),
    median:round(median),
    max:round(sorted.at(-1)!),
  };
}

function parseArgs():{mode:Mode;iterations:number} {
  const args=process.argv.slice(2);
  const mode:Mode=args.includes('--live')?'live':'mock';
  const at=args.indexOf('--iterations');
  const iterations=at>=0?Number(args[at+1]):mode==='live'?3:25;
  if (!Number.isSafeInteger(iterations) || iterations<1 || iterations>100) {
    throw new Error('INVALID_ITERATIONS');
  }
  return {mode,iterations};
}

function repository(id:number,fullName:string) {
  const [owner,name]=fullName.split('/');
  return {
    id,
    node_id:`R_${id}`,
    full_name:fullName,
    name,
    owner:{login:owner},
  };
}

async function runSample(
  mode:Mode,
  index:number,
  live:{
    token:string;
    repositoryId:number;
    repositoryFullName:string;
    commitSha:string;
    runId:string;
  }|null,
):Promise<Sample> {
  const root=mkdtempSync(join(tmpdir(),'overcenter-production-latency-'));
  const database=join(root,'authority.sqlite');
  const repositoryId=live?.repositoryId??42;
  const repositoryFullName=live?.repositoryFullName??'acme/widget';
  const commitSha=live?.commitSha??'a'.repeat(40);
  const context=mode==='live'
    ? `overcenter/latency/${live!.runId}`
    : `overcenter/latency/mock/${index}`;
  const token=live?.token??'mock-token';
  let phase:Phase='idle';
  let providerState=false;
  let readbackMs=0;

  const rawGet:GithubJsonGet=mode==='live'
    ? githubGet
    : (_token,path)=>{
        if (path==='/repos/acme/widget') {
          return repository(repositoryId,repositoryFullName);
        }
        if (path.startsWith(`/repos/acme/widget/commits/${commitSha}/status?`)) {
          return {
            state:providerState?'success':'pending',
            sha:commitSha,
            total_count:providerState?1:0,
            repository:repository(repositoryId,repositoryFullName),
            statuses:providerState
              ? [{
                  id:index+1,
                  node_id:`STATUS_${index+1}`,
                  state:'success',
                  context,
                  target_url:null,
                  created_at:'2026-09-20T21:00:00Z',
                  updated_at:'2026-09-20T21:00:01Z',
                }]
              : [],
          };
        }
        if (path.startsWith(`/repos/acme/widget/commits/${commitSha}/statuses?`)) {
          return providerState
            ? [{
                id:index+1,
                node_id:`STATUS_${index+1}`,
                state:'success',
                context,
                target_url:null,
                created_at:'2026-09-20T21:00:00Z',
                updated_at:'2026-09-20T21:00:01Z',
              }]
            : [];
        }
        throw new Error(`UNEXPECTED_GITHUB_GET:${path}`);
      };

  const get:GithubJsonGet=(providerToken,path)=>{
    const started=performance.now();
    try {
      return rawGet(providerToken,path);
    } finally {
      if (phase==='settlement') {
        readbackMs+=performance.now()-started;
      }
    }
  };

  const post:GithubStatusPost|undefined=mode==='mock'
    ? async()=>{
        providerState=true;
        return {status:201,body:'{}'};
      }
    : undefined;

  const kernel=new TimedKernel(database,{
    githubToken:token,
    observationContext:{githubGet:get},
  });
  kernel.initialize();

  try {
    const totalStarted=performance.now();
    const authorityStarted=performance.now();

    kernel.define({
      id:`latency-${index}`,
      packet:{effect_contract:GITHUB_COMMIT_STATUS_EFFECT},
      postcondition:{
        verifier:'github-commit-status/v2',
        provider:'github',
        repository_id:repositoryId,
        repository_full_name:repositoryFullName,
        commit_sha:commitSha,
        context,
        expected_state:'success',
      },
    });
    const work=kernel.deriveReadyWork();
    assert.ok(work);
    const permit=kernel.claim(work.id,work.revision);
    const authorityMs=performance.now()-authorityStarted;

    phase='effect';
    const effectStarted=performance.now();
    let identityMs=0;
    const identityGet:GithubJsonGet=(providerToken,path)=>{
      const started=performance.now();
      try {
        return get(providerToken,path);
      } finally {
        identityMs+=performance.now()-started;
      }
    };
    await performGithubCommitStatusEffect(kernel,permit,{
      token,
      get:identityGet,
      ...(post?{post}:{}),
    });
    const effectTotalMs=performance.now()-effectStarted;

    phase='settlement';
    const settlementStarted=performance.now();
    const receipt=kernel.resolve(permit);
    const settlementMs=performance.now()-settlementStarted;
    phase='idle';

    const totalMs=performance.now()-totalStarted;
    assert.equal(receipt.disposition,'DONE');
    assert.equal(receipt.verified,true);

    const effectLocalMs=Math.max(
      0,
      effectTotalMs
        - identityMs
        - kernel.reservationMs
        - kernel.effectBoundaryMs,
    );
    const settlementLocalMs=Math.max(0,settlementMs-readbackMs);
    const overcenterLocalMs=
      authorityMs
      + kernel.reservationMs
      + effectLocalMs
      + settlementLocalMs;
    const providerMs=
      identityMs
      + kernel.effectBoundaryMs
      + readbackMs;

    return {
      authority_ms:round(authorityMs),
      provider_identity_ms:round(identityMs),
      effect_reservation_ms:round(kernel.reservationMs),
      mutation_boundary_ms:round(kernel.effectBoundaryMs),
      effect_local_ms:round(effectLocalMs),
      readback_ms:round(readbackMs),
      settlement_local_ms:round(settlementLocalMs),
      overcenter_local_ms:round(overcenterLocalMs),
      provider_ms:round(providerMs),
      total_ms:round(totalMs),
    };
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
}

const {mode,iterations}=parseArgs();
const live=mode==='live'
  ? {
      token:required('GITHUB_TOKEN'),
      repositoryId:Number(required('REPOSITORY_ID')),
      repositoryFullName:required('GITHUB_REPOSITORY'),
      commitSha:required('SOURCE_SHA'),
      runId:required('GITHUB_RUN_ID'),
    }
  : null;
if (
  live
  && (
    !Number.isSafeInteger(live.repositoryId)
    || live.repositoryId<1
    || !/^[0-9a-f]{40,64}$/i.test(live.commitSha)
  )
) throw new Error('INVALID_LIVE_IDENTITY');

const samples:Sample[]=[];
for (let i=0;i<iterations;i+=1) {
  samples.push(await runSample(mode,i,live));
}

const metrics=Object.keys(samples[0]) as Array<keyof Sample>;
const summary=Object.fromEntries(
  metrics.map(metric=>[metric,stats(samples.map(sample=>sample[metric]))]),
);
const result={
  mode,
  iterations,
  node:process.version,
  samples,
  summary,
};
console.log(JSON.stringify(result,null,2));

const stepSummary=process.env.GITHUB_STEP_SUMMARY;
if (stepSummary) {
  const rows=[
    ['Authority',summary.authority_ms],
    ['Provider identity',summary.provider_identity_ms],
    ['Effect reservation',summary.effect_reservation_ms],
    ['Mutation boundary',summary.mutation_boundary_ms],
    ['Authoritative readback',summary.readback_ms],
    ['Settlement local',summary.settlement_local_ms],
    ['Overcenter local total',summary.overcenter_local_ms],
    ['Provider total',summary.provider_ms],
    ['End to end',summary.total_ms],
  ];
  appendFileSync(stepSummary,[
    '# Production latency benchmark',
    '',
    `Mode: **${mode}**, samples: **${iterations}**`,
    '',
    '| Bucket | min ms | median ms | max ms |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map(([label,value])=>{
      const s=value as ReturnType<typeof stats>;
      return `| ${label} | ${s.min} | ${s.median} | ${s.max} |`;
    }),
    '',
    'Each sample uses a fresh initialized SQLite authority with one GitHub-status obligation.',
    'The benchmark measures successful steady-state execution, not recovery or large-history projection scaling.',
    '',
  ].join('\n'));
}
