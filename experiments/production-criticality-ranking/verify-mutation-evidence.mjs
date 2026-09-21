#!/usr/bin/env node
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {summarize} from './summarize-mutation.mjs';
import {assertMutationEvidence} from './mutation-evidence.mjs';

const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sha256=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');

function selectorIdentity(selector){
  return `${selector.file}::${selector.qualifiedName??selector.name??''}`;
}
function expectedSelectors(probe){
  return (probe.ranges??[]).map(range=>`${range.file}::${range.qualifiedName??range.name??''}`).sort();
}

export function verifyMutationEvidence({
  root=process.cwd(),
  committed,
  report,
  reportBytes=Buffer.from(JSON.stringify(report)),
  resolved,
  workflowRunId,
}){
  assertMutationEvidence(committed);
  if(!Number.isInteger(workflowRunId)||workflowRunId<=0){
    throw new Error('workflowRunId is required to verify mutation evidence');
  }
  if(resolved.schema!=='overcenter-criticality-resolved-mutation-probes/v1'){
    throw new Error(`unsupported resolved mutation probe schema: ${resolved.schema}`);
  }

  const probes=(committed.probes??[]).filter(
    probe=>probe.source_run.workflow_run_id===workflowRunId,
  );
  if(probes.length===0) throw new Error(`no mutation evidence cites workflow run ${workflowRunId}`);
  const source=probes[0].source_run;
  for(const probe of probes){
    if(JSON.stringify(probe.source_run)!==JSON.stringify(source)){
      throw new Error(`workflow run ${workflowRunId} has inconsistent mutation provenance`);
    }
  }
  if(sha256(reportBytes)!==source.mutation_report_sha256){
    throw new Error('mutation report digest does not match committed provenance');
  }

  const rows=new Map(summarize(report,resolved).map(row=>[row.id,row]));
  const rangesById=new Map((resolved.probes??[]).map(probe=>[probe.id,probe]));
  const stale=[];
  for(const probe of probes){
    const row=rows.get(probe.id);
    const resolvedProbe=rangesById.get(probe.id);
    if(!row||!resolvedProbe) throw new Error(`missing authoritative mutation data for ${probe.id}`);
    const claims={
      total:row.total,
      killed:row.killed,
      survived:row.survived,
      no_coverage:row.noCoverage,
      timeout_or_error:row.timeout+row.runtimeError,
      mutation_score:row.mutationScore,
    };
    for(const [key,value] of Object.entries(claims)){
      if(probe[key]!==value) throw new Error(`mutation claim mismatch for ${probe.id}.${key}`);
    }

    const actualSelectors=(probe.selectors??[]).map(selectorIdentity).sort();
    const authoritativeSelectors=expectedSelectors(resolvedProbe);
    if(JSON.stringify(actualSelectors)!==JSON.stringify(authoritativeSelectors)){
      throw new Error(`mutation selector mismatch for ${probe.id}`);
    }

    const files=[...new Set((resolvedProbe.ranges??[]).map(range=>range.file))].sort();
    const claimedFiles=Object.keys(probe.source_blobs??{}).sort();
    if(JSON.stringify(files)!==JSON.stringify(claimedFiles)){
      throw new Error(`source blob set mismatch for ${probe.id}`);
    }
    for(const file of files){
      const historical=git(root,['rev-parse',`${source.revision}:${file}`]);
      const expected=probe.source_blobs[file];
      if(historical!==expected){
        throw new Error(`historical source blob mismatch for ${probe.id}:${file}`);
      }
      const current=git(root,['hash-object',file]);
      if(current!==expected) stale.push({probe:probe.id,file,expected,current});
    }
  }

  return {
    workflowRunId,
    revision:source.revision,
    probes:probes.length,
    stale,
  };
}

function parseArgs(argv){
  const out={
    root:process.cwd(),
    committed:'experiments/production-criticality-ranking/mutation-evidence.json',
    report:'authoritative-mutation-evidence/mutation.json',
    ranges:'authoritative-mutation-evidence/mutation-ranges.json',
    workflowRunId:null,
  };
  for(let i=2;i<argv.length;i++){
    const a=argv[i];
    if(a==='--root') out.root=path.resolve(argv[++i]);
    else if(a==='--committed') out.committed=path.resolve(argv[++i]);
    else if(a==='--report') out.report=path.resolve(argv[++i]);
    else if(a==='--ranges') out.ranges=path.resolve(argv[++i]);
    else if(a==='--workflow-run-id') out.workflowRunId=Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=parseArgs(process.argv);
  const committed=JSON.parse(fs.readFileSync(args.committed,'utf8'));
  const reportBytes=fs.readFileSync(args.report);
  const report=JSON.parse(reportBytes);
  const resolved=JSON.parse(fs.readFileSync(args.ranges,'utf8'));
  const result=verifyMutationEvidence({
    root:args.root,
    committed,
    report,
    reportBytes,
    resolved,
    workflowRunId:args.workflowRunId,
  });
  process.stdout.write(`Verified ${result.probes} mutation probes from workflow run ${result.workflowRunId} at ${result.revision}.\n`);
  if(result.stale.length){
    process.stdout.write(`Current source has ${result.stale.length} stale mutation-evidence binding(s):\n`);
    for(const item of result.stale) process.stdout.write(`- ${item.probe}: ${item.file}\n`);
  }
}
