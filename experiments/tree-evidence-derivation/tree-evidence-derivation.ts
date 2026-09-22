import {canonicalDigest} from '../../src/digest.ts';

export const TREE_EVIDENCE_SCHEMA='overcenter-tree-evidence/v1' as const;
export const TREE_EVIDENCE_PROVENANCE_SCHEMA='overcenter-tree-evidence-provenance/v1' as const;
export const TREE_EVIDENCE_POLICY_SCHEMA='overcenter-tree-evidence-policy/v1' as const;
export const TREE_EVIDENCE_APPLICABILITY_SCHEMA='overcenter-tree-evidence-applicability/v1' as const;
export const REVISION_EVIDENCE_SCHEMA='overcenter-revision-evidence/v1' as const;
export const MERGE_EVIDENCE_BUNDLE_SCHEMA='overcenter-merge-evidence-bundle/v1' as const;

const TREE_OUTCOME_KEYS=[
  'unit_regression',
  'deterministic_experiments',
  'git_stress',
  'formal',
  'production_boundary',
] as const;

type TreeOutcomeKey=typeof TREE_OUTCOME_KEYS[number];

export interface TreeEvidenceReceipt {
  schema:typeof TREE_EVIDENCE_SCHEMA;
  source_tree_sha256:string;
  proof_contract_sha256:string;
  proof_environment_sha256:string;
  outcomes:Record<TreeOutcomeKey,'success'>;
}

export interface TreeEvidenceProvenance {
  schema:typeof TREE_EVIDENCE_PROVENANCE_SCHEMA;
  candidate_source_sha:string;
  candidate_base_sha:string;
  candidate_git_tree_sha:string;
  candidate_run_id:number;
  candidate_run_conclusion:'success';
  tree_evidence_sha256:string;
}

export interface TreeEvidencePolicy {
  schema:typeof TREE_EVIDENCE_POLICY_SCHEMA;
  proof_contract_sha256:string;
  proof_environment_sha256:string;
}

export interface MergeRevisionWitness {
  merge_sha:string;
  merge_git_tree_sha:string;
  parents:[string,string];
  recomputed_source_tree_sha256:string;
}

export interface TreeEvidenceApplicability {
  schema:typeof TREE_EVIDENCE_APPLICABILITY_SCHEMA;
  target_source_sha:string;
  source_tree_sha256:string;
  inherited_tree_evidence_sha256:string;
  proof_contract_sha256:string;
  proof_environment_sha256:string;
  candidate_source_sha:string;
  candidate_run_id:number;
  derivation_sha256:string;
}

export interface RevisionEvidenceReceipt {
  schema:typeof REVISION_EVIDENCE_SCHEMA;
  source_sha:string;
  exact_lineage:'success';
  self_application:'success';
  revision_environment_sha256:string;
}

export interface MergeEvidenceBundle {
  schema:typeof MERGE_EVIDENCE_BUNDLE_SCHEMA;
  source_sha:string;
  tree_evidence_mode:'derived';
  inherited_tree_evidence_sha256:string;
  tree_applicability_sha256:string;
  revision_evidence_sha256:string;
}

function exactObject(value:unknown,required:string[],name:string):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) {
    throw new Error(`${name}_INVALID`);
  }
  const record=value as Record<string,unknown>;
  const keys=Object.keys(record).sort();
  const expected=[...required].sort();
  if (
    keys.length!==expected.length
    || keys.some((key,index)=>key!==expected[index])
  ) {
    throw new Error(`${name}_SHAPE_INVALID`);
  }
  return record;
}

function objectId(value:unknown,name:string):string {
  if (typeof value!=='string' || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function taggedSha256(value:unknown,name:string):string {
  if (typeof value!=='string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function positiveInteger(value:unknown,name:string):number {
  if (!Number.isSafeInteger(value) || Number(value)<=0) {
    throw new Error(`${name}_INVALID`);
  }
  return Number(value);
}

function taggedDigest(value:unknown):string {
  return 'sha256:'+canonicalDigest(value);
}

export function validateTreeEvidenceReceipt(value:unknown):TreeEvidenceReceipt {
  const record=exactObject(value,[
    'schema',
    'source_tree_sha256',
    'proof_contract_sha256',
    'proof_environment_sha256',
    'outcomes',
  ],'TREE_EVIDENCE');
  if (record.schema!==TREE_EVIDENCE_SCHEMA) throw new Error('TREE_EVIDENCE_SCHEMA_MISMATCH');
  taggedSha256(record.source_tree_sha256,'TREE_EVIDENCE_SOURCE_TREE_SHA256');
  taggedSha256(record.proof_contract_sha256,'TREE_EVIDENCE_PROOF_CONTRACT_SHA256');
  taggedSha256(record.proof_environment_sha256,'TREE_EVIDENCE_PROOF_ENVIRONMENT_SHA256');
  const outcomes=exactObject(record.outcomes,[...TREE_OUTCOME_KEYS],'TREE_EVIDENCE_OUTCOMES');
  for (const key of TREE_OUTCOME_KEYS) {
    if (outcomes[key]!=='success') throw new Error(`TREE_EVIDENCE_OUTCOME_NOT_SUCCESS:${key}`);
  }
  return value as TreeEvidenceReceipt;
}

export function treeEvidenceDigest(value:unknown):string {
  return taggedDigest(validateTreeEvidenceReceipt(value));
}

function validateProvenance(value:unknown):TreeEvidenceProvenance {
  const record=exactObject(value,[
    'schema',
    'candidate_source_sha',
    'candidate_base_sha',
    'candidate_git_tree_sha',
    'candidate_run_id',
    'candidate_run_conclusion',
    'tree_evidence_sha256',
  ],'TREE_EVIDENCE_PROVENANCE');
  if (record.schema!==TREE_EVIDENCE_PROVENANCE_SCHEMA) {
    throw new Error('TREE_EVIDENCE_PROVENANCE_SCHEMA_MISMATCH');
  }
  objectId(record.candidate_source_sha,'TREE_EVIDENCE_CANDIDATE_SOURCE_SHA');
  objectId(record.candidate_base_sha,'TREE_EVIDENCE_CANDIDATE_BASE_SHA');
  objectId(record.candidate_git_tree_sha,'TREE_EVIDENCE_CANDIDATE_GIT_TREE_SHA');
  positiveInteger(record.candidate_run_id,'TREE_EVIDENCE_CANDIDATE_RUN_ID');
  if (record.candidate_run_conclusion!=='success') {
    throw new Error('TREE_EVIDENCE_CANDIDATE_RUN_NOT_SUCCESS');
  }
  taggedSha256(record.tree_evidence_sha256,'TREE_EVIDENCE_DIGEST');
  return value as TreeEvidenceProvenance;
}

function validatePolicy(value:unknown):TreeEvidencePolicy {
  const record=exactObject(value,[
    'schema',
    'proof_contract_sha256',
    'proof_environment_sha256',
  ],'TREE_EVIDENCE_POLICY');
  if (record.schema!==TREE_EVIDENCE_POLICY_SCHEMA) throw new Error('TREE_EVIDENCE_POLICY_SCHEMA_MISMATCH');
  taggedSha256(record.proof_contract_sha256,'TREE_EVIDENCE_POLICY_CONTRACT_SHA256');
  taggedSha256(record.proof_environment_sha256,'TREE_EVIDENCE_POLICY_ENVIRONMENT_SHA256');
  return value as TreeEvidencePolicy;
}

function validateMergeWitness(value:unknown):MergeRevisionWitness {
  const record=exactObject(value,[
    'merge_sha',
    'merge_git_tree_sha',
    'parents',
    'recomputed_source_tree_sha256',
  ],'MERGE_REVISION_WITNESS');
  objectId(record.merge_sha,'MERGE_SHA');
  objectId(record.merge_git_tree_sha,'MERGE_GIT_TREE_SHA');
  if (!Array.isArray(record.parents) || record.parents.length!==2) {
    throw new Error('MERGE_PARENTS_INVALID');
  }
  objectId(record.parents[0],'MERGE_PARENT_0');
  objectId(record.parents[1],'MERGE_PARENT_1');
  taggedSha256(record.recomputed_source_tree_sha256,'MERGE_SOURCE_TREE_SHA256');
  return value as MergeRevisionWitness;
}

export function deriveTreeEvidenceApplicability(
  evidenceValue:unknown,
  provenanceValue:unknown,
  policyValue:unknown,
  mergeValue:unknown,
):TreeEvidenceApplicability {
  const evidence=validateTreeEvidenceReceipt(evidenceValue);
  const provenance=validateProvenance(provenanceValue);
  const policy=validatePolicy(policyValue);
  const merge=validateMergeWitness(mergeValue);
  const evidenceSha256=treeEvidenceDigest(evidence);

  if (provenance.tree_evidence_sha256!==evidenceSha256) {
    throw new Error('TREE_EVIDENCE_PROVENANCE_DIGEST_MISMATCH');
  }
  if (evidence.proof_contract_sha256!==policy.proof_contract_sha256) {
    throw new Error('TREE_EVIDENCE_CONTRACT_NOT_ADMITTED');
  }
  if (evidence.proof_environment_sha256!==policy.proof_environment_sha256) {
    throw new Error('TREE_EVIDENCE_ENVIRONMENT_NOT_ADMITTED');
  }
  if (merge.parents[0]!==provenance.candidate_base_sha) {
    throw new Error('TREE_EVIDENCE_MERGE_BASE_MISMATCH');
  }
  if (merge.parents[1]!==provenance.candidate_source_sha) {
    throw new Error('TREE_EVIDENCE_MERGE_HEAD_MISMATCH');
  }
  if (merge.merge_git_tree_sha!==provenance.candidate_git_tree_sha) {
    throw new Error('TREE_EVIDENCE_GIT_TREE_MISMATCH');
  }
  if (merge.recomputed_source_tree_sha256!==evidence.source_tree_sha256) {
    throw new Error('TREE_EVIDENCE_SOURCE_TREE_MISMATCH');
  }

  const derivation={
    target_source_sha:merge.merge_sha,
    candidate_source_sha:provenance.candidate_source_sha,
    candidate_base_sha:provenance.candidate_base_sha,
    candidate_run_id:provenance.candidate_run_id,
    candidate_git_tree_sha:provenance.candidate_git_tree_sha,
    merge_git_tree_sha:merge.merge_git_tree_sha,
    source_tree_sha256:evidence.source_tree_sha256,
    inherited_tree_evidence_sha256:evidenceSha256,
    proof_contract_sha256:evidence.proof_contract_sha256,
    proof_environment_sha256:evidence.proof_environment_sha256,
  };

  return {
    schema:TREE_EVIDENCE_APPLICABILITY_SCHEMA,
    target_source_sha:merge.merge_sha,
    source_tree_sha256:evidence.source_tree_sha256,
    inherited_tree_evidence_sha256:evidenceSha256,
    proof_contract_sha256:evidence.proof_contract_sha256,
    proof_environment_sha256:evidence.proof_environment_sha256,
    candidate_source_sha:provenance.candidate_source_sha,
    candidate_run_id:provenance.candidate_run_id,
    derivation_sha256:taggedDigest(derivation),
  };
}

export function admitMergeEvidence(
  applicability:TreeEvidenceApplicability,
  revisionValue:unknown,
):MergeEvidenceBundle {
  const app=exactObject(applicability,[
    'schema',
    'target_source_sha',
    'source_tree_sha256',
    'inherited_tree_evidence_sha256',
    'proof_contract_sha256',
    'proof_environment_sha256',
    'candidate_source_sha',
    'candidate_run_id',
    'derivation_sha256',
  ],'TREE_EVIDENCE_APPLICABILITY');
  if (app.schema!==TREE_EVIDENCE_APPLICABILITY_SCHEMA) {
    throw new Error('TREE_EVIDENCE_APPLICABILITY_SCHEMA_MISMATCH');
  }
  objectId(app.target_source_sha,'TREE_EVIDENCE_TARGET_SOURCE_SHA');
  taggedSha256(app.inherited_tree_evidence_sha256,'TREE_EVIDENCE_INHERITED_DIGEST');
  taggedSha256(app.derivation_sha256,'TREE_EVIDENCE_DERIVATION_DIGEST');

  const revision=exactObject(revisionValue,[
    'schema',
    'source_sha',
    'exact_lineage',
    'self_application',
    'revision_environment_sha256',
  ],'REVISION_EVIDENCE');
  if (revision.schema!==REVISION_EVIDENCE_SCHEMA) throw new Error('REVISION_EVIDENCE_SCHEMA_MISMATCH');
  objectId(revision.source_sha,'REVISION_EVIDENCE_SOURCE_SHA');
  if (revision.exact_lineage!=='success') throw new Error('REVISION_EVIDENCE_LINEAGE_NOT_SUCCESS');
  if (revision.self_application!=='success') throw new Error('REVISION_EVIDENCE_SELF_APPLICATION_NOT_SUCCESS');
  taggedSha256(revision.revision_environment_sha256,'REVISION_EVIDENCE_ENVIRONMENT_SHA256');
  if (revision.source_sha!==app.target_source_sha) {
    throw new Error('REVISION_EVIDENCE_TARGET_MISMATCH');
  }

  return {
    schema:MERGE_EVIDENCE_BUNDLE_SCHEMA,
    source_sha:revision.source_sha as string,
    tree_evidence_mode:'derived',
    inherited_tree_evidence_sha256:app.inherited_tree_evidence_sha256 as string,
    tree_applicability_sha256:taggedDigest(applicability),
    revision_evidence_sha256:taggedDigest(revisionValue),
  };
}
