#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {summarize} from './summarize-mutation.mjs';
import {MUTATION_EVIDENCE_SCHEMA} from './mutation-evidence.mjs';

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
const rows=new Map(summarize(report,resolved).map(row=>[row.id,row]));
const sourceRun={
  revision:git(args.root,['rev-parse','HEAD']),
  workflow_run_id:args.workflowRunId,
  mutation_report_sha256:sha256(reportBytes),
  ...(args.artifactDigest?{artifact_digest:args.artifactDigest}:{}),
};
const probes=resolved.probes.map(probe=>{
  const row=rows.get(probe.id);
  if(!row) throw new Error(`missing mutation summary row for ${probe.id}`);
  const sourceBlobs={};
  for(const file of [...new Set(probe.ranges.map(range=>range.file))]){
    sourceBlobs[file]=git(args.root,['hash-object',file]);
  }
  return {
    id:probe.id,
    source_run:sourceRun,
    source_blobs:sourceBlobs,
    selectors:probe.ranges.map(range=>({file:range.file,qualifiedName:range.qualifiedName})),
    total:row.total,
    killed:row.killed,
    survived:row.survived,
    no_coverage:row.noCoverage,
    timeout_or_error:row.timeout+row.runtimeError,
    mutation_score:row.mutationScore,
  };
});
const evidence={schema:MUTATION_EVIDENCE_SCHEMA,probes};
fs.writeFileSync(args.output,JSON.stringify(evidence,null,2)+'\n');
process.stdout.write(JSON.stringify(evidence,null,2)+'\n');
