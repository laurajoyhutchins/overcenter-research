import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  CANDIDATE_TREE_EVIDENCE_ARTIFACT_SCHEMA,
  TREE_EVIDENCE_APPLICABILITY_SCHEMA,
  validateCandidateTreeEvidenceArtifact,
} from '../src/tree-evidence.ts';
import {
  createCandidateTreeEvidenceArtifact,
  deriveArtifactApplicability,
  gitSourceTreeSha256,
  gitTreeSha,
  locateSuccessfulCandidateTreeEvidence,
  revisionEnvironmentSha256,
  treeEvidencePolicy,
} from '../src/tree-evidence-runtime.ts';

function git(root:string,args:string[]):string {
  return execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
}

function fixture():{root:string;base:string;head:string;merge:string;cleanup:()=>void} {
  const root=mkdtempSync(join(tmpdir(),'overcenter-tree-evidence-runtime-'));
  git(root,['init','-q']);
  git(root,['config','user.email','test@example.com']);
  git(root,['config','user.name','Test']);
  mkdirSync(join(root,'executor'),{recursive:true});
  writeFileSync(join(root,'.node-version'),'22.16.0\n');
  writeFileSync(join(root,'.go-version'),'1.24.5\n');
  writeFileSync(join(root,'rust-toolchain.toml'),'[toolchain]\nchannel = "1.88.0"\nprofile = "minimal"\n');
  writeFileSync(
    join(root,'executor/runtime-images.json'),
    JSON.stringify({
      schema:'overcenter-runtime-images-v2',
      node_runtime:'node:22.16.0-bookworm-slim@sha256:'+'1'.repeat(64),
      node_self_application:'node:22.16.0-bookworm@sha256:'+'2'.repeat(64),
    })+'\n',
  );
  writeFileSync(join(root,'same.txt'),'same bytes\n');
  git(root,['add','.']);
  git(root,['commit','-qm','base']);
  const base=git(root,['rev-parse','HEAD']);
  writeFileSync(join(root,'feature.txt'),'feature\n');
  git(root,['add','.']);
  git(root,['commit','-qm','head']);
  const head=git(root,['rev-parse','HEAD']);
  const tree=git(root,['rev-parse',`${head}^{tree}`]);
  const merge=git(root,['commit-tree',tree,'-p',base,'-p',head,'-m','synthetic merge']);
  return {
    root,
    base,
    head,
    merge,
    cleanup:()=>rmSync(root,{recursive:true,force:true}),
  };
}

test('candidate artifact binds exact Git tree and source-tree bytes',()=>{
  const f=fixture();
  try {
    const artifact=createCandidateTreeEvidenceArtifact({
      root:f.root,
      sourceSha:f.head,
      baseSha:f.base,
      runId:99,
    });
    assert.equal(artifact.schema,CANDIDATE_TREE_EVIDENCE_ARTIFACT_SCHEMA);
    assert.equal(artifact.provenance.candidate_git_tree_sha,gitTreeSha(f.root,f.head));
    assert.equal(
      artifact.tree_evidence.source_tree_sha256,
      gitSourceTreeSha256(f.root,f.head),
    );
    assert.deepEqual(validateCandidateTreeEvidenceArtifact(artifact),artifact);
  } finally {
    f.cleanup();
  }
});

test('identical-content synthetic merge derives applicability for observed candidate run',()=>{
  const f=fixture();
  try {
    const artifact=createCandidateTreeEvidenceArtifact({
      root:f.root,
      sourceSha:f.head,
      baseSha:f.base,
      runId:101,
    });
    const applicability=deriveArtifactApplicability({
      root:f.root,
      artifact,
      mergeSha:f.merge,
      observedCandidateRunId:101,
    });
    assert.equal(applicability.schema,TREE_EVIDENCE_APPLICABILITY_SCHEMA);
    assert.equal(applicability.target_source_sha,f.merge);
    assert.equal(applicability.candidate_source_sha,f.head);
    assert.throws(
      ()=>deriveArtifactApplicability({
        root:f.root,
        artifact,
        mergeSha:f.merge,
        observedCandidateRunId:102,
      }),
      /TREE_EVIDENCE_OBSERVED_RUN_ID_MISMATCH/,
    );
  } finally {
    f.cleanup();
  }
});

test('policy is deterministic and revision environment remains SHA-bound',()=>{
  const root=new URL('../',import.meta.url).pathname;
  assert.deepEqual(treeEvidencePolicy(root),treeEvidencePolicy(root));
  assert.notEqual(
    revisionEnvironmentSha256(root,'1'.repeat(40)),
    revisionEnvironmentSha256(root,'2'.repeat(40)),
  );
});

test('GitHub lookup selects newest successful exact-head Merge gate with one unexpired artifact',async()=>{
  const head='a'.repeat(40);
  const calls:string[]=[];
  const get=async(_token:string,path:string)=>{
    calls.push(path);
    if (path.includes('/actions/runs?')) {
      return {
        status:200,
        body:JSON.stringify({
          workflow_runs:[
            {id:12,path:'.github/workflows/merge-gate.yml',event:'workflow_dispatch',head_sha:head,status:'completed',conclusion:'success'},
            {id:11,path:'.github/workflows/merge-gate.yml',event:'workflow_dispatch',head_sha:head,status:'completed',conclusion:'success'},
            {id:13,path:'.github/workflows/merge-gate.yml',event:'pull_request',head_sha:head,status:'completed',conclusion:'success'},
          ],
        }),
      };
    }
    if (path.includes('/12/artifacts')) {
      return {
        status:200,
        body:JSON.stringify({artifacts:[
          {id:120,name:'overcenter-tree-evidence',expired:false,digest:'sha256:abc'},
        ]}),
      };
    }
    throw new Error(`unexpected path ${path}`);
  };
  const located=await locateSuccessfulCandidateTreeEvidence(
    'token',
    'acme/widget',
    head,
    get,
  );
  assert.deepEqual(located,{
    run_id:12,
    artifact_id:120,
    artifact_digest:'sha256:abc',
  });
  assert.equal(calls.length,2);
});

test('GitHub lookup fails closed on ambiguous artifacts and ignores failed runs',async()=>{
  const head='b'.repeat(40);
  await assert.rejects(
    locateSuccessfulCandidateTreeEvidence(
      'token',
      'acme/widget',
      head,
      async(_token,path)=>{
        if (path.includes('/actions/runs?')) {
          return {
            status:200,
            body:JSON.stringify({workflow_runs:[
              {id:20,path:'.github/workflows/merge-gate.yml',event:'workflow_dispatch',head_sha:head,status:'completed',conclusion:'success'},
            ]}),
          };
        }
        return {
          status:200,
          body:JSON.stringify({artifacts:[
            {id:1,name:'overcenter-tree-evidence',expired:false},
            {id:2,name:'overcenter-tree-evidence',expired:false},
          ]}),
        };
      },
    ),
    /TREE_EVIDENCE_ARTIFACT_AMBIGUOUS/,
  );

  const absent=await locateSuccessfulCandidateTreeEvidence(
    'token',
    'acme/widget',
    head,
    async()=>({
      status:200,
      body:JSON.stringify({workflow_runs:[
        {id:21,path:'.github/workflows/merge-gate.yml',event:'workflow_dispatch',head_sha:head,status:'completed',conclusion:'failure'},
      ]}),
    }),
  );
  assert.equal(absent,null);
});
