#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {summarize} from './summarize-mutation.mjs';

const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const sha256=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');

function parseArgs(argv){
  const out={root:process.cwd(),report:'mutation.json',ranges:'mutation-ranges.json',output:'mutation-evidence.json',workflowRunId:null,artifactDigest:null};
  for(let i=2;i<argv.length;i++){
    const a=argv[i];
    if(a==='--root') out.root=path.resolve(argv[++i]);
    else if(a==='--report') out.report=path.resolve(argv[++i]);
    else if(a==='--ranges') out.ranges=path.resolve(argv[++i]);
    else if(a==='--output') out.output=path.resolve(argv[++i]);
    else if(a==='--workflow-run-id') out.workflowRunId=Number(argv[++i]);
    else if(a==='--artifact-digest') out.artifactDigest=argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const args=parseArgs(process.argv);
const reportBytes=fs.readFileSync(args.report);
const report=JSON.parse(reportBytes);
const resolved=JSON.parse(fs.readFileSync(args.ranges,'utf8'));
const rows=new Map(summarize(report,resolved).map(r=>[r.id,r]));
const sourceRun={\n  revision:git(args.root,['rev-parse','HEAD']),\n  workflow_run_id:args.workflowRunId,\n  mutation_report_sha256:sha256(reportBytes),\n};\nconst probes=resolved.probes.map(p=>{
  const row=rows.get(p.id);
  if(!row) throw new Error(`missing mutation summary row for ${p.id}`);
  const sourceBlobs={};
  for(const file of [...new Set(p.ranges.map(r=>r.file))]) sourceBlobs[file]=git(args.root,['hash-object',file]);
  return {
    id:p.id,
    source_blobs:sourceBlobs,
    selectors:p.ranges.map(r=>({file:r.file,qualifiedName:r.qualifiedName})),
    total:row.total,
    killed:row.killed,
    survived:row.survived,
    no_coverage:row.noCoverage,
    timeout_or_error:row.timeout+row.runtimeError,
    mutation_score:row.mutationScore,
  };
});
const evidence={
  schema:'overcenter-criticality-mutation-evidence/v1',
  source_run:{
    revision:git(args.root,['rev-parse','HEAD']),
    workflow_run_id:args.workflowRunId,
    artifact_digest:args.artifactDigest,
    mutation_report_sha256:sha256(reportBytes),
  },
  probes,
};
fs.writeFileSync(args.output,JSON.stringify(evidence,null,2)+'\n');
process.stdout.write(JSON.stringify(evidence,null,2)+'\n');
