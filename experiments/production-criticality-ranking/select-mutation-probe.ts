#!/usr/bin/env node
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export const MUTATION_WORKFLOW='.github/workflows/production-criticality-mutation-probe.yml';
export const MUTATION_SELECTOR='experiments/production-criticality-ranking/select-mutation-probe.ts';
export const MUTATION_SELECTOR_TEST='experiments/production-criticality-ranking/select-mutation-probe.test.ts';

const isRelevant=(file)=>
  /^(src\/(digest|semantic-identity|projector|kernel-core|observation)\.ts|test\/(hostile|.*-hostile)\.test\.ts|experiments\/production-criticality-ranking\/(mutation-probes\.json|resolve-mutation-probes\.ts|generate-stryker-config\.ts|summarize-mutation\.ts|summarize-mutation\.test\.ts|emit-mutation-evidence\.ts))$/.test(file)
  || [MUTATION_WORKFLOW,MUTATION_SELECTOR,MUTATION_SELECTOR_TEST].includes(file);

const isBroad=(file)=>
  /^src\/(digest|projector|kernel-core)\.ts$/.test(file)
  || /^experiments\/production-criticality-ranking\/(mutation-probes\.json|resolve-mutation-probes\.ts|generate-stryker-config\.ts|summarize-mutation\.ts|summarize-mutation\.test\.ts|emit-mutation-evidence\.ts)$/.test(file);

const isPlumbing=(file)=>
  file===MUTATION_WORKFLOW
  || file===MUTATION_SELECTOR
  || file===MUTATION_SELECTOR_TEST;

export function selectMutationProbe({eventName,changed}) {
  if (eventName==='workflow_dispatch') {
    return {runProbe:true,mutationProbe:''};
  }

  const files=[...new Set(changed.filter(Boolean))];
  const relevant=files.filter(isRelevant);
  if (relevant.length===0) {
    return {runProbe:false,mutationProbe:''};
  }

  if (relevant.some(isBroad)) {
    return {runProbe:true,mutationProbe:''};
  }

  const probes=[];
  if (files.some(file=>
    file==='src/semantic-identity.ts'
    || file==='test/semantic-identity-hostile.test.ts'
  )) {
    probes.push('semantic-identity');
  }
  if (files.some(file=>
    file==='src/observation.ts'
    || file==='test/observation-hostile.test.ts'
  )) {
    probes.push('verification-and-absence');
  }
  if (probes.length>0) {
    return {runProbe:true,mutationProbe:probes.join(',')};
  }

  if (relevant.every(isPlumbing)) {
    return {runProbe:true,mutationProbe:'semantic-identity'};
  }

  return {runProbe:true,mutationProbe:''};
}

if (import.meta.url===pathToFileURL(process.argv[1]).href) {
  const eventName=process.argv[2]??'';
  const changed=fs.readFileSync(0,'utf8').split(/\r?\n/).filter(Boolean);
  const selected=selectMutationProbe({eventName,changed});
  process.stdout.write(
    `run_probe=${selected.runProbe}\nmutation_probe=${selected.mutationProbe}\n`,
  );
}
