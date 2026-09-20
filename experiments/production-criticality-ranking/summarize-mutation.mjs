#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

function score(mutants){
  const relevant=mutants.filter(m=>!['Ignored','CompileError'].includes(m.status));
  const count=status=>relevant.filter(m=>m.status===status).length;
  const killed=count('Killed');
  const survived=count('Survived');
  const noCoverage=count('NoCoverage');
  const timeout=count('Timeout');
  const runtimeError=count('RuntimeError');
  const denominator=killed+survived+noCoverage+timeout+runtimeError;
  return {total:denominator,killed,survived,noCoverage,timeout,runtimeError,mutationScore:denominator?killed/denominator:1};
}
function overlaps(mutant,range){
  const start=mutant.location?.start?.line??0;
  const end=mutant.location?.end?.line??start;
  return end>=range.start && start<=range.end;
}
export function summarize(report,resolved){
  const rows=[];
  for(const probe of resolved.probes??[]){
    const mutants=[];
    for(const range of probe.ranges??[]){
      const file=report.files?.[range.file];
      for(const mutant of file?.mutants??[]) if(overlaps(mutant,range)) mutants.push(mutant);
    }
    const unique=[...new Map(mutants.map(m=>[m.id,m])).values()];
    rows.push({id:probe.id,ranges:probe.ranges,...score(unique)});
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
  const weak=rows.filter(r=>r.survived+r.noCoverage>0);
  lines.push('','## Surviving or uncovered mutants','');
  if(!weak.length) lines.push('All selected semantic regions killed every non-equivalent mutant produced by this probe.');
  for(const r of weak) lines.push(`- ${r.id}: ${r.survived} survived, ${r.noCoverage} uncovered.`);
  return lines.join('\n')+'\n';
}
if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const input=process.argv[2]??'mutation.json';
  const ranges=process.argv[3]??'mutation-ranges.json';
  const out=process.argv[4]??'mutation-summary.md';
  const report=JSON.parse(fs.readFileSync(input,'utf8'));
  const resolved=JSON.parse(fs.readFileSync(ranges,'utf8'));
  const rows=summarize(report,resolved);
  const md=markdown(rows);
  fs.writeFileSync(out,md);
  process.stdout.write(md);
}
