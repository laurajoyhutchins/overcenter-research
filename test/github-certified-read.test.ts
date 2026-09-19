import assert from 'node:assert/strict';
import test from 'node:test';
import { observeCertifiedGithubSemanticRead } from '../src/providers/github-certified-read.ts';

const SHA='a'.repeat(40);
const repository=()=>({
  id:42,
  node_id:'R_42',
  full_name:'acme/widget',
  name:'widget',
  owner:{login:'acme'},
});

test('generic certified read turns an issue GET into positive schema-bound evidence',()=>{
  const seen:string[]=[];
  const result=observeCertifiedGithubSemanticRead('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    operation:'issue',
    parameters:{issue_number:17},
    clock:()=> '2026-09-19T18:00:00.000Z',
    get:(_token,path)=>{
      seen.push(path);
      if (path==='/repos/acme/widget') return repository();
      if (path==='/repos/acme/widget/issues/17') {
        return {
          id:1700,
          node_id:'I_17',
          number:17,
          state:'open',
          state_reason:null,
          title:'Observed issue',
          locked:false,
          updated_at:'2026-09-19T17:59:00Z',
        };
      }
      throw new Error('unexpected path:'+path);
    },
  });

  assert.equal(result.state,'observed');
  if (result.state!=='observed') return;
  assert.deepEqual(seen,['/repos/acme/widget','/repos/acme/widget/issues/17']);
  assert.equal(result.evidence.operation_id,'issues/get');
  assert.equal(result.evidence.repository_id,42);
  assert.equal(result.evidence.negative_evidence_authoritative,false);
  assert.equal(result.evidence.optional_absent_paths.includes('pull_request'),true);
});

test('workflow run request uses generated parameters and remains positive-only',()=>{
  const result=observeCertifiedGithubSemanticRead('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    operation:'workflow_run',
    parameters:{run_id:7001,exclude_pull_requests:true},
    get:(_token,path)=>{
      if (path==='/repos/acme/widget') return repository();
      assert.equal(path,'/repos/acme/widget/actions/runs/7001?exclude_pull_requests=true');
      return {
        id:7001,
        node_id:'WFR_7001',
        workflow_id:88,
        run_number:12,
        run_attempt:1,
        name:'Tests',
        event:'push',
        status:'completed',
        conclusion:'success',
        head_sha:SHA,
        head_branch:'main',
        path:'.github/workflows/tests.yml',
        created_at:'2026-09-19T17:00:00Z',
        updated_at:'2026-09-19T17:05:00Z',
      };
    },
  });

  assert.equal(result.state,'observed');
  if (result.state!=='observed') return;
  assert.equal(result.evidence.operation_id,'actions/get-workflow-run');
  assert.equal(result.evidence.paginated,false);
});

test('failed or negative provider reads remain indeterminate rather than proving absence',()=>{
  const result=observeCertifiedGithubSemanticRead('token',{
    repositoryId:42,
    repositoryFullName:'acme/widget',
    operation:'release',
    parameters:{release_id:999},
    get:(_token,path)=>{
      if (path==='/repos/acme/widget') return repository();
      throw new Error('GITHUB_GET_FAILED:404');
    },
  });

  assert.equal(result.state,'indeterminate');
  if (result.state!=='indeterminate') return;
  assert.equal(result.operation_id,'repos/get-release');
  assert.match(result.observation_error,/404/);
});

test('caller cannot override repository identity or omit exact path coordinates',()=>{
  assert.throws(
    ()=>observeCertifiedGithubSemanticRead('token',{
      repositoryId:42,
      repositoryFullName:'acme/widget',
      operation:'issue',
      parameters:{owner:'other',issue_number:17},
    }),
    /GITHUB_SEMANTIC_READ_PARAMETER_RESERVED:owner/,
  );

  assert.throws(
    ()=>observeCertifiedGithubSemanticRead('token',{
      repositoryId:42,
      repositoryFullName:'acme/widget',
      operation:'workflow_job',
    }),
    /GITHUB_OPERATION_PARAMETER_REQUIRED:job_id/,
  );
});
