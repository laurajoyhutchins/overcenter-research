#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const registry=JSON.parse(readFileSync('experiments/registry.json','utf8'));
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const experimentReadme=readFileSync('experiments/README.md','utf8');
const entries=registry.entries??[];
const fail=m=>{throw new Error(`EXPERIMENT_CONTRACT: ${m}`);};
const text=(e,k)=>{if(typeof e[k]!=='string'||!e[k].trim())fail(`${e.id}: missing ${k}`);};
const strings=(e,k)=>{if(!Array.isArray(e[k])||!e[k].length||e[k].some(x=>typeof x!=='string'||!x.trim()))fail(`${e.id}: missing ${k}`);};
function npmScript(e,cmd){const m=/^npm run ([^ ]+)/.exec(cmd);if(m&&!pkg.scripts?.[m[1]])fail(`${e.id}: npm script ${m[1]} does not exist`);}

function verify(){
  if(registry.schema!=='overcenter-experiment-registry/v2')fail('registry schema must be overcenter-experiment-registry/v2');
  const ids=new Set(),dirs=new Set();
  for(const e of entries){
    for(const k of ['id','kind','status','directory','readme'])text(e,k);
    if(ids.has(e.id))fail(`duplicate id ${e.id}`); ids.add(e.id);
    if(dirs.has(e.directory))fail(`duplicate directory ${e.directory}`); dirs.add(e.directory);
    if(!existsSync(e.directory)||!existsSync(e.readme))fail(`${e.id}: directory/README missing`);
    if(!['maintained','historical'].includes(e.status))fail(`${e.id}: invalid status`);
    if(e.kind==='support'){text(e,'purpose');continue;}
    if(e.kind!=='experiment')fail(`${e.id}: unknown kind`);
    if(!experimentReadme.includes(`\`${e.directory.replace(/^experiments\//,'')}/\``))fail(`${e.id}: missing from experiments/README.md index`);

    for(const k of ['question','claim','contrast','interpretation'])text(e,k);
    for(const k of ['environment','success_criteria','non_claims'])strings(e,k);

    if(!e.design||!['preregistered','retrospective','mixed','unknown'].includes(e.design.provenance))fail(`${e.id}: invalid design provenance`);
    text(e.design,'note');

    if(!e.outcome||!['pending','supported','falsified','mixed','inconclusive'].includes(e.outcome.state))fail(`${e.id}: invalid outcome state`);
    text(e.outcome,'summary');

    const genericSuccess='The hostile cases and distinguishing criterion documented in the experiment README pass.';
    const genericNonClaim='Anything outside the documented experiment boundary.';
    if(e.success_criteria.includes(genericSuccess))fail(`${e.id}: success criteria must be explicit in the registry`);
    if(e.non_claims.includes(genericNonClaim))fail(`${e.id}: non-claims must be explicit in the registry`);
    if(e.environment.some(x=>x.includes('See experiment README')))fail(`${e.id}: material environment must be explicit in the registry`);

    if(!e.reproduce||typeof e.reproduce.local!=='string'||!e.reproduce.local.trim())fail(`${e.id}: missing reproduce.local`);
    text(e.reproduce,'tier'); npmScript(e,e.reproduce.local);

    if(!e.evidence||!['evaluated','pending'].includes(e.evidence.status))fail(`${e.id}: invalid evidence status`);
    if(!Array.isArray(e.evidence.artifacts)||!e.evidence.artifacts.length)fail(`${e.id}: evidence artifact required`);
    if(e.evidence.status==='evaluated'){
      if(!/^[0-9a-f]{40}$/.test(e.evidence.evaluated_revision??''))fail(`${e.id}: exact evaluated revision required`);
      if(e.outcome.state==='pending')fail(`${e.id}: evaluated evidence cannot have a pending outcome`);
    }else{
      if(e.evidence.evaluated_revision!==undefined)fail(`${e.id}: pending evidence cannot name an evaluated revision`);
      if(e.outcome.state!=='pending')fail(`${e.id}: non-pending outcome requires evaluated evidence`);
      text(e.evidence,'pending_reason');
    }
  }

  const registered=new Set(entries.map(e=>e.directory.replace(/^experiments\//,'')));
  const actual=readdirSync('experiments',{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort();
  const missing=actual.filter(x=>!registered.has(x));
  if(missing.length)fail(`unregistered experiment directories: ${missing.join(', ')}`);
  console.log(`experiment contract: ${entries.filter(e=>e.kind==='experiment').length} experiments + ${entries.filter(e=>e.kind==='support').length} support entries verified`);
}

function list(){
  for(const e of entries){
    if(e.kind==='support')console.log(`${e.id}\tsupport\t${e.status}\t-\t${e.purpose}`);
    else console.log(`${e.id}\t${e.status}\t${e.design.provenance}\t${e.outcome.state}\t${e.evidence.status}\t${e.reproduce.tier}\t${e.reproduce.local}`);
  }
}

function runOne(e){
  if(!e||e.kind!=='experiment')fail('unknown experiment');
  console.log(`\n=== ${e.id} ===\n${e.question}\n$ ${e.reproduce.local}\n`);
  const r=spawnSync(e.reproduce.local,{shell:true,stdio:'inherit'});
  if(r.status!==0)process.exit(r.status??1);
}

const [cmd,arg]=process.argv.slice(2);
if(cmd==='verify')verify();
else if(cmd==='list')list();
else if(cmd==='run'&&arg==='--all-deterministic'){verify();for(const e of entries.filter(e=>e.kind==='experiment'&&e.reproduce.tier==='deterministic'))runOne(e);}
else if(cmd==='run'&&arg){verify();runOne(entries.find(e=>e.id===arg));}
else{console.error('usage: experiments.ts verify | list | run <id> | run --all-deterministic');process.exit(2);}
