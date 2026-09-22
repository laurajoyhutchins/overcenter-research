import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MERGE_EVIDENCE_BUNDLE_SCHEMA,
  REVISION_EVIDENCE_SCHEMA,
  TREE_EVIDENCE_POLICY_SCHEMA,
  TREE_EVIDENCE_PROVENANCE_SCHEMA,
  TREE_EVIDENCE_SCHEMA,
  admitMergeEvidence,
  deriveTreeEvidenceApplicability,
  treeEvidenceDigest,
} from './tree-evidence-derivation.ts';

const BASE='1'.repeat(40);
const HEAD='2'.repeat(40);
const MERGE='3'.repeat(40);
const GIT_TREE='4'.repeat(40);
const SOURCE_TREE='sha256:'+'5'.repeat(64);
const CONTRACT='sha256:'+'6'.repeat(64);
const ENVIRONMENT='sha256:'+'7'.repeat(64);
const REVISION_ENVIRONMENT='sha256:'+'8'.repeat(64);

function evidence(overrides:Record<string,unknown>={}) {
  return {
    schema:TREE_EVIDENCE_SCHEMA,
    source_tree_sha256:SOURCE_TREE,
    proof_contract_sha256:CONTRACT,
    proof_environment_sha256:ENVIRONMENT,
    outcomes:{
      unit_regression:'success',
      deterministic_experiments:'success',
      git_stress:'success',
      formal:'success',
      production_boundary:'success',
    },
    ...overrides,
  };
}

function provenance(overrides:Record<string,unknown>={}) {
  const receipt=evidence();
  return {
    schema:TREE_EVIDENCE_PROVENANCE_SCHEMA,
    candidate_source_sha:HEAD,
    candidate_base_sha:BASE,
    candidate_git_tree_sha:GIT_TREE,
    candidate_run_id:12345,
    candidate_run_conclusion:'success',
    tree_evidence_sha256:treeEvidenceDigest(receipt),
    ...overrides,
  };
}

function policy(overrides:Record<string,unknown>={}) {
  return {
    schema:TREE_EVIDENCE_POLICY_SCHEMA,
    proof_contract_sha256:CONTRACT,
    proof_environment_sha256:ENVIRONMENT,
    ...overrides,
  };
}

function merge(overrides:Record<string,unknown>={}) {
  return {
    merge_sha:MERGE,
    merge_git_tree_sha:GIT_TREE,
    parents:[BASE,HEAD],
    recomputed_source_tree_sha256:SOURCE_TREE,
    ...overrides,
  };
}

function revision(overrides:Record<string,unknown>={}) {
  return {
    schema:REVISION_EVIDENCE_SCHEMA,
    source_sha:MERGE,
    exact_lineage:'success',
    self_application:'success',
    revision_environment_sha256:REVISION_ENVIRONMENT,
    ...overrides,
  };
}

test('tree evidence derives applicability without pretending it executed on the merge revision',()=>{
  const receipt=evidence();
  const applicability=deriveTreeEvidenceApplicability(
    receipt,
    provenance(),
    policy(),
    merge(),
  );
  assert.equal(applicability.target_source_sha,MERGE);
  assert.equal(applicability.candidate_source_sha,HEAD);
  assert.equal(applicability.inherited_tree_evidence_sha256,treeEvidenceDigest(receipt));

  const admitted=admitMergeEvidence(applicability,revision());
  assert.equal(admitted.schema,MERGE_EVIDENCE_BUNDLE_SCHEMA);
  assert.equal(admitted.source_sha,MERGE);
  assert.equal(admitted.tree_evidence_mode,'derived');
});

test('tree evidence rejects revision-bound fields instead of silently ignoring them',()=>{
  assert.throws(
    ()=>deriveTreeEvidenceApplicability(
      evidence({source_sha:HEAD}),
      provenance(),
      policy(),
      merge(),
    ),
    /TREE_EVIDENCE_SHAPE_INVALID/,
  );
  assert.throws(
    ()=>deriveTreeEvidenceApplicability(
      evidence({candidate_run_id:12345}),
      provenance(),
      policy(),
      merge(),
    ),
    /TREE_EVIDENCE_SHAPE_INVALID/,
  );
});

test('derivation fails closed on stale lineage or changed source content',()=>{
  assert.throws(
    ()=>deriveTreeEvidenceApplicability(evidence(),provenance(),policy(),merge({parents:[HEAD,BASE]})),
    /TREE_EVIDENCE_MERGE_BASE_MISMATCH/,
  );
  assert.throws(
    ()=>deriveTreeEvidenceApplicability(evidence(),provenance(),policy(),merge({parents:[BASE,'9'.repeat(40)]})),
    /TREE_EVIDENCE_MERGE_HEAD_MISMATCH/,
  );
  assert.throws(
    ()=>deriveTreeEvidenceApplicability(evidence(),provenance(),policy(),merge({merge_git_tree_sha:'a'.repeat(40)})),
    /TREE_EVIDENCE_GIT_TREE_MISMATCH/,
  );
  assert.throws(
    ()=>deriveTreeEvidenceApplicability(
      evidence(),
      provenance(),
      policy(),
      merge({recomputed_source_tree_sha256:'sha256:'+'b'.repeat(64)}),
    ),
    /TREE_EVIDENCE_SOURCE_TREE_MISMATCH/,
  );
});

test('changed proof contract, environment, failed run, or digest mismatch cannot be inherited',()=>{
  assert.throws(
    ()=>deriveTreeEvidenceApplicability(
      evidence(),
      provenance(),
      policy({proof_contract_sha256:'sha256:'+'c'.repeat(64)}),
      merge(),
    ),
    /TREE_EVIDENCE_CONTRACT_NOT_ADMITTED/,
  );
  assert.throws(
    ()=>deriveTreeEvidenceApplicability(
      evidence(),
      provenance(),
      policy({proof_environment_sha256:'sha256:'+'d'.repeat(64)}),
      merge(),
    ),
    /TREE_EVIDENCE_ENVIRONMENT_NOT_ADMITTED/,
  );
  assert.throws(
    ()=>deriveTreeEvidenceApplicability(
      evidence(),
      provenance({candidate_run_conclusion:'failure'}),
      policy(),
      merge(),
    ),
    /TREE_EVIDENCE_CANDIDATE_RUN_NOT_SUCCESS/,
  );
  assert.throws(
    ()=>deriveTreeEvidenceApplicability(
      evidence(),
      provenance({tree_evidence_sha256:'sha256:'+'e'.repeat(64)}),
      policy(),
      merge(),
    ),
    /TREE_EVIDENCE_PROVENANCE_DIGEST_MISMATCH/,
  );
});

test('fresh revision evidence for the merge SHA is mandatory',()=>{
  const applicability=deriveTreeEvidenceApplicability(evidence(),provenance(),policy(),merge());
  assert.throws(
    ()=>admitMergeEvidence(applicability,revision({source_sha:HEAD})),
    /REVISION_EVIDENCE_TARGET_MISMATCH/,
  );
  assert.throws(
    ()=>admitMergeEvidence(applicability,revision({self_application:'failure'})),
    /REVISION_EVIDENCE_SELF_APPLICATION_NOT_SUCCESS/,
  );
  assert.throws(
    ()=>admitMergeEvidence(applicability,revision({exact_lineage:'failure'})),
    /REVISION_EVIDENCE_LINEAGE_NOT_SUCCESS/,
  );
});

test('real PR 234 merge coordinates satisfy the strict two-parent content-preserving relation',()=>{
  const realBase='c70800559230b3d9286fb9d9107b87c14fab4f14';
  const realHead='392cad7c36cdb3c167c4e6a78d20056c23c0ab4c';
  const realMerge='a994978638a8d52cacac858b2f0ebeca75c2b681';
  const realGitTree='dc7fdb04d23ad7f3bde3b0a5edbdcf4ea8605f7c';

  const receipt=evidence();
  const applicability=deriveTreeEvidenceApplicability(
    receipt,
    provenance({
      candidate_source_sha:realHead,
      candidate_base_sha:realBase,
      candidate_git_tree_sha:realGitTree,
    }),
    policy(),
    merge({
      merge_sha:realMerge,
      merge_git_tree_sha:realGitTree,
      parents:[realBase,realHead],
    }),
  );
  assert.equal(applicability.target_source_sha,realMerge);
  assert.equal(applicability.candidate_source_sha,realHead);
});
