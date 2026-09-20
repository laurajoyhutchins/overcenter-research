#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

function semantic(snapshot){
  return {schema:snapshot.schema,probes:snapshot.probes??[]};
}

export function verifyMutationEvidence({
  root=process.cwd(),
  committed,
  authoritative,
}){
  if(committed.schema!=='overcenter-criticality-mutation-evidence/v1'){
    throw new Error(`unsupported committed mutation evidence schema: ${committed.schema}`);
  }
  if(authoritative.schema!==committed.schema){
    throw new Error(`authoritative mutation evidence schema mismatch: ${authoritative.schema}`);
  }
  const source=committed.source_run??{};
  const generatedSource=authoritative.source_run??{};
  if(source.workflow_run_id!==generatedSource.workflow_run_id
    || source.revision!==generatedSource.revision
    || source.mutation_report_sha256!==generatedSource.mutation_report_sha256){
    throw new Error('committed mutation evidence does not preserve authoritative source-run identity');
  }
  if(JSON.stringify(semantic(committed))!==JSON.stringify(semantic(authoritative))){
    throw new Error('committed mutation evidence does not match the authoritative workflow artifact');
  }
  const stale=[];
  for(const probe of committed.probes??[]){
    for(const [file,expected] of Object.entries(probe.source_blobs??{})){
      const actual=git(root,['hash-object',file]);
      if(actual!==expected) stale.push({probe:probe.id,file,expected,actual});
    }
  }
  if(stale.length){
    throw new Error(`committed mutation evidence is stale for current source: ${stale.map(x=>`${x.probe}:${x.file}`).join(', ')}`);
  }
  return {workflowRunId:source.workflow_run_id,revision:source.revision,probes:(committed.probes??[]).length};
}

function parseArgs(argv){
  const out={
    root:process.cwd(),
    committed:'experiments/production-criticality-ranking/mutation-evidence.json',
    authoritative:'authoritative-mutation-evidence/mutation-evidence-generated.json',
  };
  for(let i=2;i<argv.length;i++){
    const a=argv[i];
    if(a==='--root') out.root=path.resolve(argv[++i]);
    else if(a==='--committed') out.committed=path.resolve(argv[++i]);
    else if(a==='--authoritative') out.authoritative=path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=parseArgs(process.argv);
  const committed=JSON.parse(fs.readFileSync(args.committed,'utf8'));
  const authoritative=JSON.parse(fs.readFileSync(args.authoritative,'utf8'));
  const result=verifyMutationEvidence({root:args.root,committed,authoritative});
  process.stdout.write(`Verified ${result.probes} mutation probes from workflow run ${result.workflowRunId} at ${result.revision}.\n`);
}
