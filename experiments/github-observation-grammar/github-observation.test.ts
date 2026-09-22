import assert from 'node:assert/strict';
import test from 'node:test';

import { validateResponseSlice } from '../../src/observation/response-slice.ts';
import {
  GITHUB_ISSUE_OPERATION,
  GITHUB_OBSERVATION_OPERATIONS,
  GITHUB_REF_OPERATION,
} from '../../src/providers/github/operations.generated.ts';
import { materializeGithubOperationRequest } from '../../src/providers/github/openapi.ts';
import { observeCertifiedGithubPullRequestIdentity } from '../../src/providers/github/certified-pr.ts';
import { observeCertifiedGithubRefFence } from '../../src/providers/github/certified-ref.ts';
import { observeCertifiedGithubRepository } from '../../src/providers/github/certified-repository.ts';
import { observeCertifiedGithubSemanticRead } from '../../src/providers/github/certified-read.ts';
import { observeCertifiedGithubCommitStatus } from '../../src/providers/github/certified-status.ts';
import {
  GITHUB_ISSUE_RESPONSE_SLICE,
  GITHUB_OPERATION_SEMANTICS,
} from '../../src/providers/github/semantics.ts';

const SHA_A='a'.repeat(40);
const SHA_B='b'.repeat(40);
const NOW='2026-09-22T20:00:00.000Z';
const token='test-token';

const repository=(fullName='acme/widget')=>{
  const [owner,name]=fullName.split('/');
  return {
    id:42,
    node_id:'R_42',
    full_name:fullName,
    name,
    owner:{login:owner},
  };
};

const status=(context='overcenter/proof')=>({
  id:7,
  node_id:'STATUS_7',
  state:'success' as const,
  context,
  target_url:null,
  created_at:NOW,
  updated_at:NOW,
});

test('production registry is the only observation grammar and admits read operations only',()=>{
  assert.equal(
    Object.keys(GITHUB_OBSERVATION_OPERATIONS).length,
    Object.keys(GITHUB_OPERATION_SEMANTICS).length,
  );
  for (const [name,operation] of Object.entries(GITHUB_OBSERVATION_OPERATIONS)) {
    const semantic=GITHUB_OPERATION_SEMANTICS[name as keyof typeof GITHUB_OPERATION_SEMANTICS];
    assert.ok(['GET','HEAD'].includes(operation.method),operation.operation_id);
    assert.equal(operation.operation_id,semantic.operation_id);
    assert.ok(semantic.required_permissions.length>0,operation.operation_id);
  }

  assert.throws(
    ()=>materializeGithubOperationRequest(GITHUB_REF_OPERATION,{
      owner:'acme',
      repo:'widget',
      ref:'heads/main',
      Authorization:'spoof',
    }),
    /GITHUB_OPERATION_PARAMETER_UNKNOWN:Authorization/,
  );
});

test('stable repository identity is distinct from its mutable coordinate',()=>{
  const first=observeCertifiedGithubRepository(token,{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    observerId:'experiment',
    clock:()=>NOW,
    get:(_token,path)=>{
      assert.equal(path,'/repos/acme/widget');
      return repository('acme/widget');
    },
  });
  const renamed=observeCertifiedGithubRepository(token,{
    repositoryId:42,
    repositoryFullName:'renamed/widget',
    observerId:'experiment',
    clock:()=>NOW,
    get:(_token,path)=>{
      assert.equal(path,'/repos/renamed/widget');
      return repository('renamed/widget');
    },
  });

  assert.deepEqual(first.fact.subject,renamed.fact.subject);
  assert.notEqual(first.fact.object.full_name,renamed.fact.object.full_name);
  assert.equal(first.fact.stability,'stable-subject-mutable-alias');
});

test('ref binding is exact and a failed provider read never proves absence',()=>{
  const get=(_token:string,path:string):unknown=>{
    if (path==='/repos/acme/widget') return repository();
    if (path==='/repos/acme/widget/git/ref/heads%2Fmain') {
      return {ref:'refs/heads/main',object:{type:'commit',sha:SHA_A}};
    }
    throw new Error(`unexpected:${path}`);
  };
  const current=observeCertifiedGithubRefFence(token,{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    ref:'heads/main',
    expectedSha:SHA_A,
    get,
    clock:()=>NOW,
  });
  const stale=observeCertifiedGithubRefFence(token,{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    ref:'heads/main',
    expectedSha:SHA_B,
    get,
    clock:()=>NOW,
  });
  const indeterminate=observeCertifiedGithubRefFence(token,{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    ref:'heads/missing',
    expectedSha:SHA_A,
    get:(_token,path)=>{
      if (path==='/repos/acme/widget') return repository();
      throw new Error('provider-404');
    },
    clock:()=>NOW,
  });

  assert.equal(current.state,'CURRENT');
  assert.equal(stale.state,'STALE');
  assert.equal(indeterminate.state,'INDETERMINATE');
  assert.match(indeterminate.observation_error??'',/provider-404/);
});

test('immutable reads project only the certified semantic slice',()=>{
  const result=observeCertifiedGithubSemanticRead(token,{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    operation:'git_commit',
    parameters:{commit_sha:SHA_A},
    grantedPermissions:['contents:read'],
    clock:()=>NOW,
    get:(_token,path)=>{
      if (path==='/repos/acme/widget') return repository();
      if (path===`/repos/acme/widget/git/commits/${SHA_A}`) {
        return {
          sha:SHA_A,
          node_id:'C_1',
          tree:{sha:SHA_B},
          parents:[{sha:SHA_B}],
          attacker_controlled:'must-not-project',
        };
      }
      throw new Error(`unexpected:${path}`);
    },
  });

  assert.equal(result.state,'observed');
  if (result.state!=='observed') return;
  assert.deepEqual(result.value,{
    sha:SHA_A,
    node_id:'C_1',
    tree:{sha:SHA_B},
    parents:[{sha:SHA_B}],
  });
});

test('mutable pull-request identity goes stale when one authority coordinate changes',()=>{
  const get=(_token:string,path:string):unknown=>{
    if (path==='/repos/acme/widget') return repository();
    if (path==='/repos/acme/widget/pulls/7') {
      return {
        id:70,
        node_id:'PR_7',
        number:7,
        state:'open',
        head:{sha:SHA_A},
        base:{ref:'main',sha:SHA_B},
      };
    }
    throw new Error(`unexpected:${path}`);
  };
  const expected={
    node_id:'PR_7',
    state:'open',
    head_sha:SHA_A,
    base_ref:'main',
    base_sha:SHA_B,
  };
  const current=observeCertifiedGithubPullRequestIdentity(token,{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    pullNumber:7,
    expected,
    get,
    clock:()=>NOW,
  });
  const stale=observeCertifiedGithubPullRequestIdentity(token,{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    pullNumber:7,
    expected:{...expected,head_sha:SHA_B},
    get,
    clock:()=>NOW,
  });

  assert.equal(current.state,'CURRENT');
  assert.equal(stale.state,'STALE');
  assert.deepEqual(stale.differences,['head_sha']);
});

test('optional issue fields are certified as absent rather than invented',()=>{
  const result=observeCertifiedGithubSemanticRead(token,{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    operation:'issue',
    parameters:{issue_number:7},
    grantedPermissions:['issues:read'],
    clock:()=>NOW,
    get:(_token,path)=>{
      if (path==='/repos/acme/widget') return repository();
      if (path==='/repos/acme/widget/issues/7') {
        return {
          id:7,
          node_id:'I_7',
          number:7,
          state:'open',
          title:'issue',
          locked:false,
          updated_at:NOW,
        };
      }
      throw new Error(`unexpected:${path}`);
    },
  });

  assert.equal(result.state,'observed');
  if (result.state!=='observed') return;
  assert.ok(result.evidence.optional_absent_paths.includes('state_reason'));
  assert.ok(result.evidence.optional_absent_paths.includes('pull_request.url'));
});

test('a complete-looking collection page remains page evidence, not absence evidence',()=>{
  for (const operation of ['check_runs_for_ref','workflow_runs'] as const) {
    const parameters=operation==='check_runs_for_ref'?{ref:SHA_A}:{};
    const permission=operation==='check_runs_for_ref'?'checks:read' as const:'actions:read' as const;
    const result=observeCertifiedGithubSemanticRead(token,{
      repositoryId:42,
      repositoryFullName:'acme/widget',
      operation,
      parameters,
      grantedPermissions:[permission],
      clock:()=>NOW,
      get:(_token,path)=>{
        if (path==='/repos/acme/widget') return repository();
        if (operation==='check_runs_for_ref' && path===`/repos/acme/widget/commits/${SHA_A}/check-runs`) {
          return {total_count:0,check_runs:[]};
        }
        if (operation==='workflow_runs' && path==='/repos/acme/widget/actions/runs') {
          return {total_count:0,workflow_runs:[]};
        }
        throw new Error(`unexpected:${path}`);
      },
    });
    assert.equal(result.state,'page-observed');
    if (result.state!=='page-observed') continue;
    assert.equal(result.evidence.collection?.completeness,'page-only');
    assert.equal(result.evidence.negative_evidence_authoritative,false);
  }
});

test('commit-status membership is positive evidence while a miss remains indeterminate',()=>{
  const positive=observeCertifiedGithubCommitStatus(token,{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    commitSha:SHA_A,
    context:'overcenter/proof',
    clock:()=>NOW,
    get:(_token,path)=>{
      if (path===`/repos/acme/widget/commits/${SHA_A}/status?page=1&per_page=100`) {
        return {
          state:'success',
          sha:SHA_A,
          total_count:1,
          repository:repository(),
          statuses:[status()],
        };
      }
      throw new Error(`unexpected:${path}`);
    },
  });
  assert.equal(positive.state,'present');
  assert.equal(positive.actual_state,'success');

  const missing=observeCertifiedGithubCommitStatus(token,{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    commitSha:SHA_A,
    context:'missing',
    clock:()=>NOW,
    get:(_token,path)=>{
      if (path===`/repos/acme/widget/commits/${SHA_A}/status?page=1&per_page=100`) {
        return {
          state:'success',
          sha:SHA_A,
          total_count:0,
          repository:repository(),
          statuses:[],
        };
      }
      if (path==='/repos/acme/widget') return repository();
      if (path===`/repos/acme/widget/commits/${SHA_A}/statuses?page=1&per_page=30`) return [];
      throw new Error(`unexpected:${path}`);
    },
  });
  assert.equal(missing.state,'indeterminate');
  assert.equal(missing.reason,'COLLECTION_ABSENCE_NOT_AUTHORITATIVE');
});

test('304 and malformed consumed fields do not become fresh certified facts',()=>{
  assert.throws(
    ()=>validateResponseSlice(
      GITHUB_ISSUE_OPERATION,
      '304',
      {},
      GITHUB_ISSUE_RESPONSE_SLICE,
    ),
    /RESPONSE_SLICE_SCHEMA_MISSING:issues\/get:304/,
  );

  const malformed=observeCertifiedGithubSemanticRead(token,{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    operation:'issue',
    parameters:{issue_number:7},
    grantedPermissions:['issues:read'],
    clock:()=>NOW,
    get:(_token,path)=>{
      if (path==='/repos/acme/widget') return repository();
      if (path==='/repos/acme/widget/issues/7') {
        return {
          id:7,
          node_id:'I_7',
          number:7,
          state:'open',
          locked:false,
          updated_at:NOW,
        };
      }
      throw new Error(`unexpected:${path}`);
    },
  });
  assert.equal(malformed.state,'indeterminate');
  if (malformed.state!=='indeterminate') return;
  assert.match(malformed.observation_error,/RESPONSE_SLICE_REQUIRED_FIELD_MISSING:title/);
});
