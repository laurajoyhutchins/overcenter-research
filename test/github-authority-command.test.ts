import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeGithubAuthorityCommand,
  githubAuthorityExitCode,
  parseGithubAuthorityCommand,
} from '../src/providers/github/authority-command.ts';
import type { GithubJsonGet } from '../src/providers/github/rest.ts';

const HEAD='a'.repeat(40);
const BASE='b'.repeat(40);

function provider():GithubJsonGet {
  return (_token,path)=>{
    if (path==='/repos/acme/widget') {
      return {
        id:42,
        node_id:'R_42',
        full_name:'acme/widget',
        name:'widget',
        owner:{login:'acme'},
      };
    }
    if (path==='/repos/acme/widget/git/ref/heads%2Fmain') {
      return {ref:'refs/heads/main',object:{type:'commit',sha:HEAD}};
    }
    if (path==='/repos/acme/widget/pulls/7') {
      return {
        id:700,
        node_id:'PR_7',
        number:7,
        state:'open',
        head:{sha:HEAD},
        base:{ref:'main',sha:BASE},
      };
    }
    throw new Error(`unexpected provider path: ${path}`);
  };
}

test('parse one ref authority command', () => {
  assert.deepEqual(parseGithubAuthorityCommand([
    'ref',
    '--repository-id','42',
    '--repository','acme/widget',
    '--ref','heads/main',
    '--expected-sha',HEAD,
  ]),{
    kind:'ref',
    repository_id:42,
    repository_full_name:'acme/widget',
    ref:'heads/main',
    expected_sha:HEAD,
  });
});

test('parse one PR authority command', () => {
  assert.deepEqual(parseGithubAuthorityCommand([
    'pr',
    '--repository-id','42',
    '--repository','acme/widget',
    '--pull-number','7',
    '--node-id','PR_7',
    '--state','open',
    '--head-sha',HEAD,
    '--base-ref','main',
    '--base-sha',BASE,
  ]),{
    kind:'pr',
    repository_id:42,
    repository_full_name:'acme/widget',
    pull_number:7,
    expected:{
      node_id:'PR_7',
      state:'open',
      head_sha:HEAD,
      base_ref:'main',
      base_sha:BASE,
    },
  });
});

test('unknown or duplicate command flags fail before provider access', () => {
  assert.throws(()=>parseGithubAuthorityCommand([
    'ref',
    '--repository-id','42',
    '--repository','acme/widget',
    '--ref','heads/main',
    '--expected-sha',HEAD,
    '--surprise','x',
  ]),/GITHUB_AUTHORITY_FLAG_UNKNOWN/);

  assert.throws(()=>parseGithubAuthorityCommand([
    'ref',
    '--repository-id','42',
    '--repository-id','43',
    '--repository','acme/widget',
    '--ref','heads/main',
    '--expected-sha',HEAD,
  ]),/GITHUB_AUTHORITY_FLAG_DUPLICATE/);
});

test('semantic command returns CURRENT and STALE with stable exit codes', () => {
  const get=provider();
  const current=executeGithubAuthorityCommand('token',{
    kind:'ref',
    repository_id:42,
    repository_full_name:'acme/widget',
    ref:'heads/main',
    expected_sha:HEAD,
  },{get});
  assert.equal(current.schema,'github-authority/v1');
  assert.equal(current.state,'CURRENT');
  assert.equal(githubAuthorityExitCode(current.state),0);

  const stale=executeGithubAuthorityCommand('token',{
    kind:'ref',
    repository_id:42,
    repository_full_name:'acme/widget',
    ref:'heads/main',
    expected_sha:'0'.repeat(40),
  },{get});
  assert.equal(stale.state,'STALE');
  assert.equal(githubAuthorityExitCode(stale.state),2);
});

test('semantic PR command exposes exact work identity', () => {
  const result=executeGithubAuthorityCommand('token',{
    kind:'pr',
    repository_id:42,
    repository_full_name:'acme/widget',
    pull_number:7,
    expected:{
      node_id:'PR_7',
      state:'open',
      head_sha:HEAD,
      base_ref:'main',
      base_sha:BASE,
    },
  },{get:provider()});

  assert.equal(result.command,'pr');
  assert.equal(result.state,'CURRENT');
  assert.equal(result.result.actual?.node_id,'PR_7');
  assert.equal(result.result.actual?.head_sha,HEAD);
});

test('authority exit code keeps indeterminate distinct from stale', () => {
  assert.equal(githubAuthorityExitCode('CURRENT'),0);
  assert.equal(githubAuthorityExitCode('STALE'),2);
  assert.equal(githubAuthorityExitCode('INDETERMINATE'),3);
});
