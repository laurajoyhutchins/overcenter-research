#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export const MUTATION_WORKFLOW='.github/workflows/production-criticality-mutation-probe.yml';
export const MUTATION_SELECTOR='experiments/production-criticality-ranking/select-mutation-probe.mjs';
export const MUTATION_SELECTOR_TEST='experiments/production-criticality-ranking/select-mutation-probe.test.mjs';
export const MUTATION_PROBES='experiments/production-criticality-ranking/mutation-probes.json';
export const EVIDENCE_EMITTER='experiments/production-criticality-ranking/emit-mutation-evidence.mjs';
export const EVIDENCE_RECONCILER='experiments/production-criticality-ranking/mutation-evidence.mjs';
export const EVIDENCE_RECONCILER_TEST='experiments/production-criticality-ranking/mutation-evidence.test.mjs';

const plumbing=new Set([
  MUTATION_WORKFLOW,
  MUTATION_SELECTOR,
  MUTATION_SELECTOR_TEST,
  EVIDENCE_EMITTER,
  EVIDENCE_RECONCILER,
  EVIDENCE_RECONCILER_TEST,
]);

const broadMechanics=new Set([
  'experiments/production-criticality-ranking/resolve-mutation-probes.mjs',
  'experiments/production-criticality-ranking/stryker.config.mjs',
  'experiments/production-criticality-ranking/summarize-mutation.mjs',
  'experiments/production-criticality-ranking/summarize-mutation.test.mjs',
]);

const targetedTests=new Map([
  ['test/semantic-identity-hostile.test.ts','semantic-identity'],
  ['test/observation-hostile.test.ts','verification-and-absence'],
]);

const hostileTest=/^test\/(?:hostile|.*-hostile)\.test\.ts$/;

function readConfig(){
  return JSON.parse(fs.readFileSync(MUTATION_PROBES,'utf8'));
}

function probeMap(config){
  return new Map((config.probes??[]).map(probe=>[probe.id,probe]));
}

export function changedMutationProbeIds(baseConfig,headConfig){
  const base=probeMap(baseConfig);
  const head=probeMap(headConfig);
  const ids=[...new Set([...base.keys(),...head.keys()])].sort();
  const changed=[];
  const removed=[];
  for(const id of ids){
    if(JSON.stringify(base.get(id))===JSON.stringify(head.get(id))) continue;
    if(!head.has(id)) removed.push(id);
    else changed.push(id);
  }
  if(removed.length){
    throw new Error(
      `mutation probe removal requires explicit evidence retirement: ${removed.join(',')}`,
    );
  }
  return changed;
}

function configuredProbeIds(probes,files){
  const changedFiles=new Set(files);
  return probes
    .filter(probe=>(probe.selectors??[]).some(
      selector=>changedFiles.has(selector.file),
    ))
    .map(probe=>probe.id);
}

export function selectMutationProbe({
  eventName,
  changed,
  probes=readConfig().probes??[],
  changedProbeIds=null,
}){
  if(eventName==='workflow_dispatch'){
    return {runProbe:true,mutationProbe:''};
  }

  const files=[...new Set(changed.filter(Boolean))];
  if(files.some(file=>broadMechanics.has(file))){
    return {runProbe:true,mutationProbe:''};
  }
  if(files.includes(MUTATION_PROBES) && changedProbeIds===null){
    return {runProbe:true,mutationProbe:''};
  }

  const configuredIds=new Set(probes.map(probe=>probe.id));
  const selected=new Set(configuredProbeIds(probes,files));
  for(const file of files){
    const id=targetedTests.get(file);
    if(id) selected.add(id);
  }
  if(changedProbeIds!==null){
    for(const id of changedProbeIds){
      if(!configuredIds.has(id)){
        throw new Error(`changed mutation probe is absent from current config: ${id}`);
      }
      selected.add(id);
    }
  }

  const unknownHostile=files.some(
    file=>hostileTest.test(file) && !targetedTests.has(file),
  );
  if(unknownHostile){
    return {runProbe:true,mutationProbe:''};
  }

  if(selected.size){
    const ordered=probes
      .map(probe=>probe.id)
      .filter(id=>selected.has(id));
    return {runProbe:true,mutationProbe:ordered.join(',')};
  }

  if(files.some(file=>plumbing.has(file))){
    return {runProbe:true,mutationProbe:'semantic-identity'};
  }

  return {runProbe:false,mutationProbe:''};
}

function configAt(ref){
  return JSON.parse(execFileSync(
    'git',
    ['show',`${ref}:${MUTATION_PROBES}`],
    {encoding:'utf8',stdio:['ignore','pipe','pipe']},
  ));
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const eventName=process.argv[2]??'';
  const changed=fs.readFileSync(0,'utf8').split(/\r?\n/).filter(Boolean);
  const config=readConfig();
  let changedProbeIds=null;
  if(eventName!=='workflow_dispatch' && changed.includes(MUTATION_PROBES)){
    const base=process.env.BASE;
    const head=process.env.HEAD;
    if(!base||!head){
      throw new Error('mutation probe config change requires BASE and HEAD');
    }
    changedProbeIds=changedMutationProbeIds(configAt(base),configAt(head));
  }
  const selected=selectMutationProbe({
    eventName,
    changed,
    probes:config.probes??[],
    changedProbeIds,
  });
  process.stdout.write(
    `run_probe=${selected.runProbe}\nmutation_probe=${selected.mutationProbe}\n`,
  );
}
