#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const registry=JSON.parse(readFileSync('experiments/registry.json','utf8'));
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const entries=registry.entries??[];
const fail=m=>{throw new Error(`EXPERIMENT_CONTRACT: ${m}`);};
const text=(e,k)=>{if(typeof e[k]!=='string'||!e[k].trim())fail(`${e.id}: missing ${k}`);};
const strings=(e,k)=>{if(!Array.isArray(e[k])||!e[k].length||e[k].some(x=>typeof x!=='string'||!x.trim()))fail(`${e.id}: missing ${k}`);};
function npmScript(e,cmd){const m=/^npm run ([^ ]+)/.exec(cmd);if(m&&!pkg.scripts?.[m[1]])fail(`${e.id}: npm script ${m[1]} does not exist`);}
function verify(){
  const ids=new Set(),dirs=new Set();
  for(const e of entries){
    for(const k of ['id','kind','directory','readme'])text(e,k);
    if(ids.has(e.id))fail(`duplicate id ${e.id}`); ids.add(e.id);
    if(dirs.has(e.directory))fail(`duplicate directory ${e.directory}`); dirs.add(e.directory);
    if(!existsSync(e.directory)||!existsSync(e.readme))fail(`${e.id}: directory/README missing`);
    if(e.kind==='support'){text(e,'purpose');continue;}
    if(e.kind!=='experiment')fail(`${e.id}: unknown kind`);
    for(const k of ['question','claim','contrast','interpretation'])text(e,k);
    for(const k of ['environment','success_criteria','non_claims'])strings(e,k);
    if(!e.reproduce||typeof e.reproduce.local!=='string'||!e.reproduce.local.trim())fail(`${e.id}: missing reproduce.local`);
    text(e.reproduce,'tier'); npmScript(e,e.reproduce.local);
    if(!e.evidence||!['current','historical','pending'].includes(e.evidence.state))fail(`${e.id}: invalid evidence state`);
    if(e.evidence.state!=='pending'&&!/^[0-9a-f]{40}$/.test(e.evidence.evaluated_revision??''))fail(`${e.id}: exact evaluated revision required`);
    if(!Array.isArray(e.evidence.artifacts)||!e.evidence.artifacts.length)fail(`${e.id}: evidence artifact required`);
  }
  const registered=new Set(entries.map(e=>e.directory.replace(/^experiments\//,'')));
  const actual=readdirSync('experiments',{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort();
  const missing=actual.filter(x=>!registered.has(x));
  if(missing.length)fail(`unregistered experiment directories: ${missing.join(', ')}`);
  console.log(`experiment contract: ${entries.filter(e=>e.kind==='experiment').length} experiments + ${entries.filter(e=>e.kind==='support').length} support entries verified`);
}
function list(){for(const e of entries)console.log(e.kind==='support'?`${e.id}\tsupport\t-\t${e.purpose}`:`${e.id}\t${e.reproduce.tier}\t${e.evidence.state}\t${e.reproduce.local}`);}
function runOne(e){if(!e||e.kind!=='experiment')fail('unknown experiment');console.log(`\n=== ${e.id} ===\n${e.question}\n$ ${e.reproduce.local}\n`);const r=spawnSync(e.reproduce.local,{shell:true,stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
const [cmd,arg]=process.argv.slice(2);
if(cmd==='verify')verify();
else if(cmd==='list')list();
else if(cmd==='run'&&arg==='--all-deterministic'){verify();for(const e of entries.filter(e=>e.kind==='experiment'&&e.reproduce.tier==='deterministic'))runOne(e);}
else if(cmd==='run'&&arg){verify();runOne(entries.find(e=>e.id===arg));}
else{console.error('usage: experiments.mjs verify | list | run <id> | run --all-deterministic');process.exit(2);}
