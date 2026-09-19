#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const probes=[
  {id:'digest-foundation',file:'src/digest.ts',start:3,end:20},
  {id:'done-candidate-reuse',file:'src/projector.ts',start:205,end:258},
];

function score(mutants){
  const relevant=mutants.filter(m=>!['Ignored','CompileError'].includes(m.status));
  const killed=relevant.filter(m=>m.status==='Killed').length;
  const survived=relevant.filter(m=>m.status==='Survived').length;
  const noCoverage=relevant.filter(m=>m.status==='NoCoverage').length;
  const timeout=relevant.filter(m=>m.status==='Timeout').length;
  const runtimeError=relevant.filter(m=>m.status==='RuntimeError').length;
  const valid=killed+timeout+survived+noCoverage;
  const detected=killed+timeout;
  return {total:valid,killed,survived,noCoverage,timeout,runtimeError,mutationScore:valid?detected/valid:1};
}

export function summarize(report){
  const rows=[];
  for(const p of probes){
    const file=report.files?.[p.file];
    const mutants=(file?.mutants??[]).filter(m=>{
      const start=m.location?.start?.line??0;
      const end=m.location?.end?.line??start;
      return end>=p.start && start<=p.end;
    });
    rows.push({...p,...score(mutants)});
  }
  return rows;
}

export function markdown(rows){
  const lines=[
    '# Criticality mutation probe',
    '',
    '| Semantic region | Mutants | Killed | Survived | No coverage | Timeout/error | Mutation score |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for(const r of rows){
    lines.push(`| ${r.id} | ${r.total} | ${r.killed} | ${r.survived} | ${r.noCoverage} | ${r.timeout+r.runtimeError} | ${(100*r.mutationScore).toFixed(1)}% |`);
  }
  lines.push('');
  const weak=rows.filter(r=>r.survived+r.noCoverage>0);
  if(weak.length){
    lines.push('## Surviving or uncovered mutants','');
    for(const r of weak) lines.push(`- ${r.id}: ${r.survived} survived, ${r.noCoverage} uncovered.`);
  } else {
    lines.push('All selected semantic regions killed every non-equivalent mutant produced by this probe.');
  }
  return lines.join('\n')+'\n';
}

if(import.meta.url===new URL(`file://${path.resolve(process.argv[1])}`).href){
  const input=process.argv[2]??'mutation.json';
  const out=process.argv[3]??'mutation-summary.md';
  const report=JSON.parse(fs.readFileSync(input,'utf8'));
  const rows=summarize(report);
  fs.writeFileSync(out,markdown(rows));
  process.stdout.write(markdown(rows));
}
