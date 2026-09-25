#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const MUTATION_EVIDENCE_SCHEMA='overcenter-criticality-mutation-evidence';

const sha256Digest=/^sha256:[0-9a-f]{64}$/;
const revisionPattern=/^[0-9a-f]{40}$/;
const git=(root,args)=>execFileSync(
  'git',
  args,
  {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']},
).trim();

export function assertMutationSourceRun(source,{requireArtifact=true}={}){
  if(!source
    || !revisionPattern.test(source.revision??'')
    || !Number.isInteger(source.workflow_run_id)
    || source.workflow_run_id<=0
    || !sha256Digest.test(source.mutation_report_sha256??'')
    || (requireArtifact && !sha256Digest.test(source.artifact_digest??''))){
    throw new Error('mutation evidence is missing trusted-run provenance fields');
  }
  if(!requireArtifact
    && source.artifact_digest!=null
    && !sha256Digest.test(source.artifact_digest)){
    throw new Error('mutation evidence has an invalid artifact digest');
  }
  return source;
}

export function assertMutationEvidence(snapshot,{requireArtifact=true}={}){
  if(snapshot?.schema!==MUTATION_EVIDENCE_SCHEMA){
    throw new Error(`unsupported mutation evidence schema: ${snapshot?.schema}`);
  }
  const ids=new Set();
  for(const probe of snapshot.probes??[]){
    if(typeof probe.id!=='string'||!probe.id||ids.has(probe.id)){
      throw new Error(`invalid or duplicate mutation probe id: ${probe.id}`);
    }
    ids.add(probe.id);
    assertMutationSourceRun(probe.source_run,{requireArtifact});
  }
  return snapshot;
}

export function mutationEvidenceSources(snapshot){
  assertMutationEvidence(snapshot);
  const sources=new Map();
  for(const probe of snapshot.probes??[]){
    const source=probe.source_run;
    const prior=sources.get(source.workflow_run_id);
    if(prior && JSON.stringify(prior)!==JSON.stringify(source)){
      throw new Error(
        `workflow run ${source.workflow_run_id} has inconsistent mutation provenance`,
      );
    }
    sources.set(source.workflow_run_id,source);
  }
  return [...sources.values()].sort(
    (a,b)=>a.workflow_run_id-b.workflow_run_id,
  );
}

export function reconcileMutationEvidence({
  current,
  generated,
  artifactDigest,
  expectedWorkflowRunId=null,
  expectedRevision=null,
  root=process.cwd(),
}){
  assertMutationEvidence(current);
  assertMutationEvidence(generated,{requireArtifact:false});
  if(!sha256Digest.test(artifactDigest??'')){
    throw new Error('invalid authoritative artifact digest');
  }
  if(expectedWorkflowRunId!==null
    && (!Number.isInteger(expectedWorkflowRunId)||expectedWorkflowRunId<=0)){
    throw new Error('invalid expected workflow run id');
  }
  if(expectedRevision!==null && !revisionPattern.test(expectedRevision)){
    throw new Error('invalid expected revision');
  }

  const replacements=new Map();
  const skipped=[];
  for(const probe of generated.probes??[]){
    const source=probe.source_run;
    if(expectedWorkflowRunId!==null
      && source.workflow_run_id!==expectedWorkflowRunId){
      throw new Error(
        `generated mutation evidence cites workflow run ${source.workflow_run_id}, expected ${expectedWorkflowRunId}`,
      );
    }
    if(expectedRevision!==null && source.revision!==expectedRevision){
      throw new Error(
        `generated mutation evidence cites revision ${source.revision}, expected ${expectedRevision}`,
      );
    }

    const stale=[];
    for(const [file,expected] of Object.entries(probe.source_blobs??{})){
      const actual=git(root,['hash-object',file]);
      if(actual!==expected) stale.push(file);
    }
    if(stale.length){
      skipped.push({id:probe.id,files:stale});
      continue;
    }

    replacements.set(probe.id,{
      ...probe,
      source_run:{...source,artifact_digest:artifactDigest},
    });
  }

  const probes=[];
  const seen=new Set();
  for(const probe of current.probes??[]){
    const replacement=replacements.get(probe.id);
    probes.push(replacement??probe);
    seen.add(probe.id);
  }
  for(const probe of generated.probes??[]){
    if(seen.has(probe.id)||!replacements.has(probe.id)) continue;
    probes.push(replacements.get(probe.id));
  }

  return {
    snapshot:{schema:MUTATION_EVIDENCE_SCHEMA,probes},
    updated:[...replacements.keys()],
    skipped,
  };
}

function parseArgs(argv){
  const out={
    root:process.cwd(),
    current:null,
    generated:null,
    artifactDigest:null,
    workflowRunId:null,
    revision:null,
    output:null,
  };
  for(let i=2;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--root') out.root=path.resolve(argv[++i]);
    else if(arg==='--current') out.current=path.resolve(argv[++i]);
    else if(arg==='--generated') out.generated=path.resolve(argv[++i]);
    else if(arg==='--artifact-digest') out.artifactDigest=argv[++i];
    else if(arg==='--workflow-run-id') out.workflowRunId=Number(argv[++i]);
    else if(arg==='--revision') out.revision=argv[++i];
    else if(arg==='--output') out.output=path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if(!out.current
    || !out.generated
    || !out.output
    || !out.artifactDigest
    || !out.workflowRunId
    || !out.revision){
    throw new Error(
      '--current, --generated, --artifact-digest, --workflow-run-id, --revision, and --output are required',
    );
  }
  return out;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=parseArgs(process.argv);
  const current=JSON.parse(fs.readFileSync(args.current,'utf8'));
  const generated=JSON.parse(fs.readFileSync(args.generated,'utf8'));
  const result=reconcileMutationEvidence({
    current,
    generated,
    artifactDigest:args.artifactDigest,
    expectedWorkflowRunId:args.workflowRunId,
    expectedRevision:args.revision,
    root:args.root,
  });
  fs.writeFileSync(args.output,JSON.stringify(result.snapshot,null,2)+'\n');
  process.stdout.write(
    `Reconciled ${result.updated.length} mutation probe(s); skipped ${result.skipped.length} stale probe(s).\n`,
  );
  for(const item of result.skipped){
    process.stdout.write(`- skipped ${item.id}: ${item.files.join(', ')}\n`);
  }
}
