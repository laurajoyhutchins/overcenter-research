import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  executionContextSha256,
  sourceTreeSha256,
} from '../../src/execution-context.ts';
import {
  contentPreservingMergeWitness,
  type CandidateCertificationWitness,
  type GitCommitWitness,
} from './merge-evidence-substitution.ts';

const BASE='1'.repeat(40);
const HEAD='2'.repeat(40);
const MERGE='3'.repeat(40);
const TREE='4'.repeat(40);

function candidate(
  overrides:Partial<CandidateCertificationWitness>={},
):CandidateCertificationWitness {
  return {
    source_sha:HEAD,
    base_sha:BASE,
    outcome:'success',
    ...overrides,
  };
}

function head(overrides:Partial<GitCommitWitness>={}):GitCommitWitness {
  return {
    sha:HEAD,
    tree_sha:TREE,
    parents:['0'.repeat(40)],
    ...overrides,
  };
}

function merge(overrides:Partial<GitCommitWitness>={}):GitCommitWitness {
  return {
    sha:MERGE,
    tree_sha:TREE,
    parents:[BASE,HEAD],
    ...overrides,
  };
}

test('exact base/head parents plus identical tree prove a content-preserving merge relation',()=>{
  assert.deepEqual(
    contentPreservingMergeWitness(merge(),candidate(),head()),
    {
      merge_sha:MERGE,
      base_sha:BASE,
      certified_head_sha:HEAD,
      tree_sha:TREE,
    },
  );
});

test('near-miss merge relations are rejected',()=>{
  assert.equal(
    contentPreservingMergeWitness(
      merge({parents:[HEAD,BASE]}),
      candidate(),
      head(),
    ),
    null,
    'parent order is part of the witness',
  );
  assert.equal(
    contentPreservingMergeWitness(
      merge({parents:[BASE,HEAD,'5'.repeat(40)]}),
      candidate(),
      head(),
    ),
    null,
    'octopus merges are not admitted',
  );
  assert.equal(
    contentPreservingMergeWitness(
      merge({tree_sha:'6'.repeat(40)}),
      candidate(),
      head(),
    ),
    null,
    'merge-generated content changes are not admitted',
  );
  assert.equal(
    contentPreservingMergeWitness(
      merge(),
      candidate({base_sha:'7'.repeat(40)}),
      head(),
    ),
    null,
    'stale base evidence is not admitted',
  );
  assert.equal(
    contentPreservingMergeWitness(
      merge(),
      candidate({source_sha:'8'.repeat(40)}),
      head(),
    ),
    null,
    'evidence for another head is not admitted',
  );
  assert.equal(
    contentPreservingMergeWitness(
      merge(),
      candidate({outcome:'failure'}),
      head(),
    ),
    null,
    'failed candidate evidence is not admitted',
  );
});

test('same source tree is not the same current Overcenter execution identity',()=>{
  const left=mkdtempSync(join(tmpdir(),'merge-evidence-left-'));
  const right=mkdtempSync(join(tmpdir(),'merge-evidence-right-'));
  try {
    writeFileSync(join(left,'same.txt'),'identical bytes\n');
    writeFileSync(join(right,'same.txt'),'identical bytes\n');
    const leftTree=sourceTreeSha256(left);
    const rightTree=sourceTreeSha256(right);
    assert.equal(leftTree,rightTree);

    const common={
      schema:'overcenter-self-application-execution-context-v1',
      image_id:'sha256:'+'9'.repeat(64),
      source_tree_sha256:leftTree,
      containment:{network:'none',read_only_root:true},
    };
    const certifiedHeadContext=executionContextSha256({
      ...common,
      source_sha:HEAD,
    });
    const mergeCommitContext=executionContextSha256({
      ...common,
      source_sha:MERGE,
    });

    assert.notEqual(
      certifiedHeadContext,
      mergeCommitContext,
      'source_sha deliberately fences execution identity even when source bytes match',
    );
  } finally {
    rmSync(left,{recursive:true,force:true});
    rmSync(right,{recursive:true,force:true});
  }
});

test('content-preserving merge witness does not imply exact-evidence substitution',()=>{
  const witness=contentPreservingMergeWitness(merge(),candidate(),head());
  assert.ok(witness);

  const headAttestation=`passed:regression:${HEAD}\n`;
  const mergeAttestation=`passed:regression:${MERGE}\n`;
  assert.notEqual(
    headAttestation,
    mergeAttestation,
    'current trusted self-application attestations bind the source revision',
  );
});
