import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {copyRepositorySource} from '../../test/support/repository-source.ts';

const revisionEnvironment=new Set([
  'GITHUB_SHA',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_REF_TYPE',
  'GITHUB_HEAD_REF',
  'GITHUB_BASE_REF',
  'SOURCE_SHA',
  'OVERCENTER_SOURCE_SHA',
]);

function revisionFreeEnvironment():NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([name])=>!revisionEnvironment.has(name)),
  );
}

function run(source:string,command:string,args:string[]):void {
  const result=spawnSync(
    command,
    args,
    {
      cwd:source,
      env:revisionFreeEnvironment(),
      stdio:'inherit',
    },
  );
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed in revision-free source snapshot`,
  );
}

const scratch=mkdtempSync(join(tmpdir(),'overcenter-tree-bound-candidate-evidence-'));
const source=join(scratch,'source');

try {
  copyRepositorySource(source);
  assert.equal(existsSync(join(source,'.git')),false,'source snapshot must not contain .git');

  const ambient=spawnSync(
    'git',
    ['rev-parse','--show-toplevel'],
    {cwd:source,env:revisionFreeEnvironment(),encoding:'utf8'},
  );
  assert.notEqual(
    ambient.status,
    0,
    `snapshot unexpectedly has ambient Git identity: ${ambient.stdout}`,
  );

  run(source,'npm',['run','test:stress']);
  run(source,'npm',['run','proof:formal']);
  run(source,'npm',['run','proof:production-boundary']);

  process.stdout.write(JSON.stringify({
    schema:'overcenter-tree-bound-candidate-evidence/v1',
    git_metadata_present:false,
    ambient_git_identity:false,
    revision_environment_present:false,
    evidence:[
      'git-stress',
      'formal',
      'production-boundary',
    ],
    result:'pass',
  })+'\n');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
