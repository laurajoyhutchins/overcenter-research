#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

import {mutationEvidenceSources} from './mutation-evidence.ts';
import {verifyMutationEvidence} from './verify-mutation-evidence.ts';

const workflowPath='.github/workflows/production-criticality-mutation-probe.yml';

const getJson=async(fetchImpl,url,token)=>{
  const response=await fetchImpl(url,{headers:{
    Accept:'application/vnd.github+json',
    Authorization:`Bearer ${token}`,
    'X-GitHub-Api-Version':'2022-11-28',
  }});
  if(!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return response.json();
};

export async function verifyMutationEvidenceSources({
  root=process.cwd(),
  committed,
  repository,
  token,
  fetchImpl=fetch,
  apiBase='https://api.github.com',
}){
  if(!repository||!token) throw new Error('repository and token are required');
  const sources=mutationEvidenceSources(committed);
  const results=[];
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'criticality-mutation-evidence-'));
  try{
    for(const source of sources){
      const base=`${apiBase}/repos/${repository}`;
      const run=await getJson(fetchImpl,`${base}/actions/runs/${source.workflow_run_id}`,token);
      if(run.path!==workflowPath) throw new Error(`unexpected evidence workflow: ${run.path}`);
      if(run.head_sha!==source.revision) throw new Error(`evidence revision mismatch: ${run.head_sha} != ${source.revision}`);
      const jobs=await getJson(fetchImpl,`${base}/actions/runs/${source.workflow_run_id}/jobs?per_page=100`,token);
      const mutate=jobs.jobs?.find(job=>job.name==='mutate');
      if(mutate?.conclusion!=='success') throw new Error(`authoritative mutate job did not succeed: ${mutate?.conclusion??'missing'}`);
      const artifacts=await getJson(fetchImpl,`${base}/actions/runs/${source.workflow_run_id}/artifacts?per_page=100`,token);
      const artifact=artifacts.artifacts?.find(item=>item.name==='production-criticality-mutation-probe'&&!item.expired);
      if(!artifact) throw new Error('authoritative mutation artifact is missing or expired');
      if(artifact.digest!==source.artifact_digest){
        throw new Error(`mutation artifact digest mismatch: ${artifact.digest} != ${source.artifact_digest}`);
      }

      const archive=await fetchImpl(artifact.archive_download_url,{headers:{
        Accept:'application/vnd.github+json',
        Authorization:`Bearer ${token}`,
        'X-GitHub-Api-Version':'2022-11-28',
      }});
      if(!archive.ok) throw new Error(`GitHub artifact download ${archive.status} for run ${source.workflow_run_id}`);
      const dir=path.join(temp,String(source.workflow_run_id));
      fs.mkdirSync(dir,{recursive:true});
      const zip=path.join(temp,`${source.workflow_run_id}.zip`);
      fs.writeFileSync(zip,Buffer.from(await archive.arrayBuffer()));
      execFileSync('unzip',['-q',zip,'-d',dir]);

      const reportBytes=fs.readFileSync(path.join(dir,'mutation.json'));
      const report=JSON.parse(reportBytes);
      const resolved=JSON.parse(fs.readFileSync(path.join(dir,'mutation-ranges.json'),'utf8'));
      results.push(verifyMutationEvidence({
        root,
        committed,
        report,
        reportBytes,
        resolved,
        workflowRunId:source.workflow_run_id,
      }));
    }
  } finally {
    fs.rmSync(temp,{recursive:true,force:true});
  }
  return results;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const committed=JSON.parse(fs.readFileSync(
    'experiments/production-criticality-ranking/mutation-evidence.json',
    'utf8',
  ));
  const results=await verifyMutationEvidenceSources({
    committed,
    repository:process.env.GITHUB_REPOSITORY,
    token:process.env.GITHUB_TOKEN,
  });
  for(const result of results){
    process.stdout.write(`Verified workflow run ${result.workflowRunId}: ${result.probes} probe(s), ${result.stale.length} stale binding(s).\n`);
  }
}
