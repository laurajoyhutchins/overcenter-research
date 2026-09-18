import assert from 'node:assert/strict';
import test from 'node:test';
import {
  observeCertifiedGithubRepositoryIdentity,
} from '../src/providers/github-certified-repository.ts';
import type { GithubJsonGet } from '../src/providers/github-status.ts';

function provider({
  hintFullName='acme/widget',
  certifiedId=42,
  nodeId='R_42',
  certifiedOwner='acme',
  certifiedName='widget',
}:{
  hintFullName?:string;
  certifiedId?:number;
  nodeId?:string;
  certifiedOwner?:string;
  certifiedName?:string;
}={}):{get:GithubJsonGet;calls:string[]} {
  const calls:string[]=[];
  const get:GithubJsonGet=(_token,path)=>{
    calls.push(path);
    if (path==='/repositories/42') {
      return {id:42,full_name:hintFullName};
    }
    if (path===`/repos/${encodeURIComponent(certifiedOwner)}/${encodeURIComponent(certifiedName)}`
      || path==='/repos/acme/widget') {
      return {
        id:certifiedId,
        node_id:nodeId,
        full_name:`${certifiedOwner}/${certifiedName}`,
        name:certifiedName,
        owner:{login:certifiedOwner},
      };
    }
    throw new Error(`unexpected provider path: ${path}`);
  };
  return {get,calls};
}

test('numeric repository route is only a hint and documented repos/get certifies identity', () => {
  const p=provider();
  const result=observeCertifiedGithubRepositoryIdentity('token',{
    repositoryId:42,
    get:p.get,
    clock:()=> '2026-09-18T20:20:00.000Z',
  });

  assert.equal(result.repository_id,42);
  assert.equal(result.node_id,'R_42');
  assert.equal(result.full_name,'acme/widget');
  assert.deepEqual(p.calls,['/repositories/42','/repos/acme/widget']);
  assert.equal(result.evidence.operation_id,'repos/get');
  assert.equal(result.evidence.bootstrap_hint.authoritative,false);
  assert.equal(result.evidence.bootstrap_hint.endpoint,'/repositories/{repository_id}');
  assert.deepEqual(
    result.evidence.validated_paths,
    ['id','node_id','full_name','name','owner.login'],
  );
});

test('alias hint cannot authorize a different repository identity', () => {
  const p=provider({certifiedId:99});
  assert.throws(
    ()=>observeCertifiedGithubRepositoryIdentity('token',{
      repositoryId:42,
      get:p.get,
      clock:()=> '2026-09-18T20:21:00.000Z',
    }),
    /GITHUB_REPOSITORY_IDENTITY_MISMATCH/,
  );
});

test('certified repository identity rejects empty stable node identity', () => {
  const p=provider({nodeId:''});
  assert.throws(
    ()=>observeCertifiedGithubRepositoryIdentity('token',{
      repositoryId:42,
      get:p.get,
      clock:()=> '2026-09-18T20:22:00.000Z',
    }),
    /GITHUB_REPOSITORY_NODE_ID_INVALID/,
  );
});

test('bootstrap hint must itself refer to the requested numeric coordinate', () => {
  const calls:string[]=[];
  const get:GithubJsonGet=(_token,path)=>{
    calls.push(path);
    return {id:99,full_name:'acme/widget'};
  };
  assert.throws(
    ()=>observeCertifiedGithubRepositoryIdentity('token',{
      repositoryId:42,
      get,
      clock:()=> '2026-09-18T20:23:00.000Z',
    }),
    /GITHUB_REPOSITORY_BOOTSTRAP_HINT_INVALID/,
  );
  assert.deepEqual(calls,['/repositories/42']);
});
