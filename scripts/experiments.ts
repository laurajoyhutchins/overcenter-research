#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

interface ExperimentSection extends Record<string,unknown> {
  provenance:string;
  note:string;
}

interface ExperimentOutcome extends Record<string,unknown> {
  state:string;
  summary:string;
}

interface ExperimentReproduce extends Record<string,unknown> {
  local:string;
  tier:string;
}

interface ExperimentEvidence extends Record<string,unknown> {
  status:string;
  artifacts:unknown[];
  evaluated_revision?:string;
  pending_reason?:string;
}

interface ExperimentEntry extends Record<string,unknown> {
  id:string;
  kind:string;
  status:string;
  directory:string;
  readme:string;
  purpose?:string;
  question:string;
  claim:string;
  contrast:string;
  interpretation:string;
  environment:string[];
  success_criteria:string[];
  non_claims:string[];
  design:ExperimentSection;
  outcome:ExperimentOutcome;
  reproduce:ExperimentReproduce;
  evidence:ExperimentEvidence;
}

const registry=JSON.parse(
  readFileSync('experiments/registry.json','utf8'),
) as {schema:string;entries?:ExperimentEntry[]};
const pkg=JSON.parse(
  readFileSync('package.json','utf8'),
) as {scripts?:Record<string,string>};
const experimentReadme=readFileSync('experiments/README.md','utf8');
const entries:ExperimentEntry[]=registry.entries??[];
const fail=(message:string):never=>{throw new Error(`EXPERIMENT_CONTRACT: ${message}`);};
const text=(entry:Record<string,unknown>,key:string):void=>{
  const value=entry[key];
  if(typeof value!=='string'||!value.trim()) {
    fail(`${String(entry.id)}: missing ${key}`);
  }
};
const strings=(entry:Record<string,unknown>,key:string):void=>{
  const value=entry[key];
  if(
    !Array.isArray(value)
    || !value.length
    || value.some((item:unknown)=>typeof item!=='string'||!item.trim())
  ) {
    fail(`${String(entry.id)}: missing ${key}`);
  }
};
function npmScript(entry:ExperimentEntry,command:string):void {
  const match=/^npm run ([^ ]+)/.exec(command);
  if(match&&!pkg.scripts?.[match[1]]) {
    fail(`${entry.id}: npm script ${match[1]} does not exist`);
  }
}

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
    text(e.reproduce,'tier'); if(e.status==='maintained')npmScript(e,e.reproduce.local);

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

function runOne(e:ExperimentEntry|undefined):void {
  if(!e||e.kind!=='experiment')fail('unknown experiment');
  if(e.status==='historical')fail(`${e.id}: historical evidence lives at ${e.evidence.evaluated_revision}; check out that revision and run: ${e.reproduce.local}`);
  console.log(`\n=== ${e.id} ===\n${e.question}\n$ ${e.reproduce.local}\n`);
  const r=spawnSync(e.reproduce.local,{shell:true,stdio:'inherit'});
  if(r.status!==0)process.exit(r.status??1);
}

const [cmd,arg]=process.argv.slice(2);
if(cmd==='verify')verify();
else if(cmd==='list')list();
else if(cmd==='run'&&arg==='--all-deterministic'){verify();for(const e of entries.filter(e=>e.kind==='experiment'&&e.status==='maintained'&&e.reproduce.tier==='deterministic'))runOne(e);}
else if(cmd==='run'&&arg){verify();runOne(entries.find(e=>e.id===arg));}
else{console.error('usage: experiments.ts verify | list | run <id> | run --all-deterministic');process.exit(2);}
