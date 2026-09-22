import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  REVISION_EVIDENCE_SCHEMA,
  admitMergeEvidence,
} from '../src/tree-evidence.ts';
import {
  createCandidateTreeEvidenceArtifact,
  deriveArtifactApplicability,
  locateSuccessfulCandidateTreeEvidence,
  revisionEnvironmentSha256,
} from '../src/tree-evidence-runtime.ts';

const root=fileURLToPath(new URL('../',import.meta.url));

function option(name:string):string|null {
  const index=process.argv.indexOf(name);
  if (index<0) return null;
  const value=process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function requiredOption(name:string):string {
  const value=option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerOption(name:string):number {
  const value=Number(requiredOption(name));
  if (!Number.isSafeInteger(value) || value<=0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function writeJson(path:string,value:unknown):void {
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,JSON.stringify(value,null,2)+'\n');
}

function output(values:Record<string,string|number|boolean|null>):void {
  for (const [key,value] of Object.entries(values)) {
    const serialized=value===null?'':String(value);
    process.stdout.write(`${key}=${serialized}\n`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${serialized}\n`);
    }
  }
}

const [command]=process.argv.slice(2);
switch (command) {
  case 'emit-candidate': {
    const sourceSha=requiredOption('--source-sha').toLowerCase();
    const baseSha=requiredOption('--base-sha').toLowerCase();
    const runId=positiveIntegerOption('--run-id');
    const out=requiredOption('--out');
    const artifact=createCandidateTreeEvidenceArtifact({
      root,
      sourceSha,
      baseSha,
      runId,
    });
    writeJson(out,artifact);
    output({
      artifact_path:out,
      tree_evidence_sha256:artifact.provenance.tree_evidence_sha256,
      candidate_git_tree_sha:artifact.provenance.candidate_git_tree_sha,
    });
    break;
  }

  case 'locate-candidate': {
    const token=process.env.GITHUB_TOKEN;
    const repository=process.env.GITHUB_REPOSITORY;
    if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');
    if (!repository) throw new Error('GITHUB_REPOSITORY_REQUIRED');
    const candidateSha=requiredOption('--candidate-sha').toLowerCase();
    const found=await locateSuccessfulCandidateTreeEvidence(
      token,
      repository,
      candidateSha,
    );
    output({
      available:Boolean(found),
      run_id:found?.run_id??null,
      artifact_id:found?.artifact_id??null,
      artifact_digest:found?.artifact_digest??null,
    });
    break;
  }

  case 'derive': {
    const artifactPath=requiredOption('--artifact');
    const mergeSha=requiredOption('--merge-sha').toLowerCase();
    const observedCandidateRunId=positiveIntegerOption('--candidate-run-id');
    const out=requiredOption('--out');
    const artifact=JSON.parse(readFileSync(artifactPath,'utf8'));
    const applicability=deriveArtifactApplicability({
      root,
      artifact,
      mergeSha,
      observedCandidateRunId,
    });
    writeJson(out,applicability);
    output({
      applicability_path:out,
      derivation_sha256:applicability.derivation_sha256,
      candidate_run_id:applicability.candidate_run_id,
      candidate_source_sha:applicability.candidate_source_sha,
    });
    break;
  }

  case 'admit': {
    const applicabilityPath=requiredOption('--applicability');
    const sourceSha=requiredOption('--source-sha').toLowerCase();
    const out=requiredOption('--out');
    const applicability=JSON.parse(readFileSync(applicabilityPath,'utf8'));
    const revision={
      schema:REVISION_EVIDENCE_SCHEMA,
      source_sha:sourceSha,
      exact_lineage:'success' as const,
      self_application:'success' as const,
      revision_environment_sha256:revisionEnvironmentSha256(root,sourceSha),
    };
    const bundle=admitMergeEvidence(applicability,revision);
    writeJson(out,bundle);
    output({
      bundle_path:out,
      tree_evidence_mode:bundle.tree_evidence_mode,
      source_sha:bundle.source_sha,
      inherited_tree_evidence_sha256:bundle.inherited_tree_evidence_sha256,
    });
    break;
  }

  default:
    throw new Error(
      'usage: tree-evidence.ts emit-candidate|locate-candidate|derive|admit',
    );
}
