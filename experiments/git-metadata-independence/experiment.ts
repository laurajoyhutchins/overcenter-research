import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {copyRepositorySource} from '../../test/support/repository-source.ts';

const scratch=mkdtempSync(join(tmpdir(),'overcenter-git-metadata-independence-'));
const source=join(scratch,'source');

try {
  copyRepositorySource(source);
  assert.equal(existsSync(join(source,'.git')),false,'source snapshot must not contain .git');

  const ambient=spawnSync(
    'git',
    ['rev-parse','--show-toplevel'],
    {cwd:source,encoding:'utf8'},
  );
  assert.notEqual(
    ambient.status,
    0,
    `snapshot unexpectedly has ambient Git identity: ${ambient.stdout}`,
  );

  const suites=['test:unit','test:experiments'] as const;
  for (const suite of suites) {
    const result=spawnSync(
      'npm',
      ['run',suite],
      {
        cwd:source,
        env:{...process.env,OVERCENTER_GIT_FREE_SOURCE:'1'},
        stdio:'inherit',
      },
    );
    assert.equal(result.status,0,`${suite} failed in Git-free source snapshot`);
  }

  process.stdout.write(JSON.stringify({
    schema:'overcenter-git-metadata-independence/v1',
    git_metadata_present:false,
    ambient_git_identity:false,
    suites,
    result:'pass',
  })+'\n');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
