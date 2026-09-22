import {execFileSync,spawnSync} from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {canonicalDigest} from './digest.ts';
import {sourceTreeSha256} from './execution-context.ts';
import {
  CANDIDATE_TREE_EVIDENCE_ARTIFACT_SCHEMA,
  TREE_EVIDENCE_PROVENANCE_SCHEMA,
  TREE_EVIDENCE_POLICY_SCHEMA,
  TREE_EVIDENCE_SCHEMA,
  TREE_OUTCOME_KEYS,
  type CandidateTreeEvidenceArtifact,
  type MergeRevisionWitness,
  type TreeEvidencePolicy,
  deriveTreeEvidenceApplicability,
  taggedDigest,
  treeEvidenceDigest,
  validateCandidateTreeEvidenceArtifact,
} from './tree-evidence.ts';

export const TREE_EVIDENCE_PROOF_CONTRACT_SCHEMA='overcenter-tree-evidence-contract/v1' as const;
export const TREE_EVIDENCE_PROOF_ENVIRONMENT_SCHEMA='overcenter-tree-evidence-environment/v1' as const;

function text(path:string):string {
  return readFileSync(path,'utf8').trim();
}

function rustChannel(root:string):string {
  const source=text(join(root,'rust-toolchain.toml'));
  const match=source.match(/^channel\s*=\s*"([^"]+)"$/m);
  if (!match) throw new Error('TREE_EVIDENCE_RUST_TOOLCHAIN_INVALID');
  return match[1];
}

export function treeEvidencePolicy(root:string):TreeEvidencePolicy {
  const runtimeImages=JSON.parse(readFileSync(join(root,'executor/runtime-images.json'),'utf8'));
  const proofContract={
    schema:TREE_EVIDENCE_PROOF_CONTRACT_SCHEMA,
    outcomes:[...TREE_OUTCOME_KEYS],
    commands:{
      unit_regression:'npm run test:unit',
      deterministic_experiments:'npm run test:experiments',
      git_stress:'npm run test:stress',
      formal:'npm run proof:formal',
      production_boundary:'npm run proof:production-boundary',
    },
  };
  const proofEnvironment={
    schema:TREE_EVIDENCE_PROOF_ENVIRONMENT_SCHEMA,
    runner:'ubuntu-24.04',
    node_version:text(join(root,'.node-version')),
    go_version:text(join(root,'.go-version')),
    rust_version:rustChannel(root),
    java_major:'21',
    docker_required:true,
    runtime_images:runtimeImages,
  };
  return {
    schema:TREE_EVIDENCE_POLICY_SCHEMA,
    proof_contract_sha256:taggedDigest(proofContract),
    proof_environment_sha256:taggedDigest(proofEnvironment),
  };
}

export function gitTreeSha(root:string,sha:string):string {
  return execFileSync(
    'git',
    ['-C',root,'rev-parse',`${sha}^{tree}`],
    {encoding:'utf8'},
  ).trim().toLowerCase();
}

export function gitSourceTreeSha256(root:string,sha:string):string {
  const scratch=mkdtempSync(join(tmpdir(),'overcenter-tree-evidence-source-'));
  try {
    const archive=execFileSync(
      'git',
      ['-C',root,'archive','--format=tar',sha],
      {maxBuffer:64*1024*1024},
    );
    const extract=spawnSync('tar',['-xf','-','-C',scratch],{input:archive});
    if (extract.status!==0) {
      throw new Error(
        `TREE_EVIDENCE_SOURCE_EXTRACT_FAILED:${extract.stderr?.toString('utf8')??''}`,
      );
    }
    if (existsSync(join(scratch,'.git'))) {
      throw new Error('TREE_EVIDENCE_SOURCE_CONTAINS_GIT_METADATA');
    }
    return sourceTreeSha256(scratch);
  } finally {
    rmSync(scratch,{recursive:true,force:true});
  }
}

export function createCandidateTreeEvidenceArtifact({
  root,
  sourceSha,
  baseSha,
  runId,
}:{
  root:string;
  sourceSha:string;
  baseSha:string;
  runId:number;
}):CandidateTreeEvidenceArtifact {
  const current=execFileSync(
    'git',
    ['-C',root,'rev-parse','HEAD'],
    {encoding:'utf8'},
  ).trim().toLowerCase();
  if (current!==sourceSha.toLowerCase()) {
    throw new Error(
      `TREE_EVIDENCE_CHECKOUT_REVISION_MISMATCH:expected=${sourceSha}:actual=${current}`,
    );
  }
  const policy=treeEvidencePolicy(root);
  const treeEvidence={
    schema:TREE_EVIDENCE_SCHEMA,
    source_tree_sha256:gitSourceTreeSha256(root,sourceSha),
    proof_contract_sha256:policy.proof_contract_sha256,
    proof_environment_sha256:policy.proof_environment_sha256,
    outcomes:Object.fromEntries(
      TREE_OUTCOME_KEYS.map(key=>[key,'success']),
    ) as Record<(typeof TREE_OUTCOME_KEYS)[number],'success'>,
  };
  return {
    schema:CANDIDATE_TREE_EVIDENCE_ARTIFACT_SCHEMA,
    tree_evidence:treeEvidence,
    provenance:{
      schema:TREE_EVIDENCE_PROVENANCE_SCHEMA,
      candidate_source_sha:sourceSha.toLowerCase(),
      candidate_base_sha:baseSha.toLowerCase(),
      candidate_git_tree_sha:gitTreeSha(root,sourceSha),
      candidate_run_id:runId,
      candidate_run_conclusion:'success',
      tree_evidence_sha256:treeEvidenceDigest(treeEvidence),
    },
  };
}

export function inspectMergeRevision(
  root:string,
  mergeSha:string,
):MergeRevisionWitness {
  const parents=execFileSync(
    'git',
    ['-C',root,'show','-s','--format=%P',mergeSha],
    {encoding:'utf8'},
  ).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parents.length!==2) throw new Error('TREE_EVIDENCE_MERGE_REQUIRES_TWO_PARENTS');
  return {
    merge_sha:mergeSha.toLowerCase(),
    merge_git_tree_sha:gitTreeSha(root,mergeSha),
    parents:[parents[0],parents[1]],
    recomputed_source_tree_sha256:gitSourceTreeSha256(root,mergeSha),
  };
}

export function deriveArtifactApplicability({
  root,
  artifact,
  mergeSha,
  observedCandidateRunId,
}:{
  root:string;
  artifact:unknown;
  mergeSha:string;
  observedCandidateRunId:number;
}) {
  const validated=validateCandidateTreeEvidenceArtifact(artifact);
  if (validated.provenance.candidate_run_id!==observedCandidateRunId) {
    throw new Error('TREE_EVIDENCE_OBSERVED_RUN_ID_MISMATCH');
  }
  return deriveTreeEvidenceApplicability(
    validated.tree_evidence,
    validated.provenance,
    treeEvidencePolicy(root),
    inspectMergeRevision(root,mergeSha),
  );
}

export interface GithubTreeEvidenceLocation {
  run_id:number;
  artifact_id:number;
  artifact_digest:string|null;
}

export type GithubJsonGet=(
  token:string,
  path:string,
)=>Promise<{status:number;body:string}>;

async function githubGet(
  token:string,
  path:string,
):Promise<{status:number;body:string}> {
  const response=await fetch(`https://api.github.com${path}`,{
    headers:{
      Authorization:`Bearer ${token}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
    },
  });
  return {status:response.status,body:await response.text()};
}

function decodeObject(response:{status:number;body:string},kind:string):Record<string,unknown> {
  if (response.status!==200) {
    throw new Error(`TREE_EVIDENCE_GITHUB_${kind}_FAILED:${response.status}:${response.body}`);
  }
  let decoded:unknown;
  try {
    decoded=JSON.parse(response.body);
  } catch {
    throw new Error(`TREE_EVIDENCE_GITHUB_${kind}_INVALID_JSON`);
  }
  if (!decoded || typeof decoded!=='object' || Array.isArray(decoded)) {
    throw new Error(`TREE_EVIDENCE_GITHUB_${kind}_INVALID_OBJECT`);
  }
  return decoded as Record<string,unknown>;
}

export async function locateSuccessfulCandidateTreeEvidence(
  token:string,
  repository:string,
  candidateSha:string,
  get:GithubJsonGet=githubGet,
):Promise<GithubTreeEvidenceLocation|null> {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error('TREE_EVIDENCE_REPOSITORY_INVALID');
  }
  if (!/^[0-9a-f]{40}$/u.test(candidateSha)) {
    throw new Error('TREE_EVIDENCE_CANDIDATE_SHA_INVALID');
  }
  const [owner,name]=repository.split('/');
  const listPath=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs?head_sha=${candidateSha}&event=workflow_dispatch&per_page=100`;
  const list=decodeObject(await get(token,listPath),'RUN_LIST');
  if (!Array.isArray(list.workflow_runs)) {
    throw new Error('TREE_EVIDENCE_GITHUB_RUN_LIST_MISSING_RUNS');
  }
  const runs=(list.workflow_runs as unknown[])
    .filter((value):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value))
    .filter(run=>
      run.path==='.github/workflows/merge-gate.yml'
      && run.event==='workflow_dispatch'
      && typeof run.head_sha==='string'
      && run.head_sha.toLowerCase()===candidateSha
      && run.status==='completed'
      && run.conclusion==='success'
      && Number.isSafeInteger(Number(run.id))
      && Number(run.id)>0
    )
    .sort((left,right)=>Number(right.id)-Number(left.id));

  for (const run of runs) {
    const runId=Number(run.id);
    const artifactsPath=`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${runId}/artifacts?per_page=100`;
    const artifacts=decodeObject(await get(token,artifactsPath),'ARTIFACT_LIST');
    if (!Array.isArray(artifacts.artifacts)) {
      throw new Error('TREE_EVIDENCE_GITHUB_ARTIFACT_LIST_MISSING_ARTIFACTS');
    }
    const matches=(artifacts.artifacts as unknown[])
      .filter((value):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value))
      .filter(artifact=>
        artifact.name==='overcenter-tree-evidence'
        && artifact.expired===false
        && Number.isSafeInteger(Number(artifact.id))
        && Number(artifact.id)>0
      );
    if (matches.length>1) {
      throw new Error(`TREE_EVIDENCE_ARTIFACT_AMBIGUOUS:run=${runId}`);
    }
    if (matches.length===1) {
      const artifact=matches[0];
      return {
        run_id:runId,
        artifact_id:Number(artifact.id),
        artifact_digest:typeof artifact.digest==='string'?artifact.digest:null,
      };
    }
  }
  return null;
}

export function revisionEnvironmentSha256(
  root:string,
  sourceSha:string,
):string {
  return taggedDigest({
    schema:'overcenter-revision-evidence-environment/v1',
    source_sha:sourceSha.toLowerCase(),
    tree_policy:treeEvidencePolicy(root),
    self_application_context:'overcenter-self-application-execution-context-v1',
  });
}
