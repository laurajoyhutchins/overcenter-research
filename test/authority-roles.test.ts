import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  analyzeAuthorityRoleFlows,
  analyzeAuthorityRoles,
  type AuthorityRoleManifest,
} from '../scripts/authority-roles.ts';

test('maintained authority role manifest has one existing owner per concept', () => {
  const manifest = JSON.parse(
    readFileSync('authority-roles.json', 'utf8'),
  ) as AuthorityRoleManifest;
  assert.deepEqual(analyzeAuthorityRoles(manifest), []);
  assert.deepEqual(analyzeAuthorityRoleFlows(manifest), []);
});

test('shadow authority and authority/projection overlap fail deterministically', () => {
  const manifest: AuthorityRoleManifest = {
    schema: 'overcenter-authority-roles',
    schema_version: 1,
    roles: [
      {
        concept: 'a',
        authority: 'src/a.ts',
        projections: ['src/view.ts'],
        verifiers: ['test/a.test.ts'],
      },
      {
        concept: 'b',
        authority: 'src/a.ts',
        projections: ['src/a.ts'],
        verifiers: [],
      },
    ],
  };
  const present = new Set(['src/a.ts', 'src/view.ts', 'test/a.test.ts']);
  assert.deepEqual(
    analyzeAuthorityRoles(manifest, (path) => present.has(path)).map((finding) => finding.code),
    ['AUTHORITY_ALSO_PROJECTION', 'DUPLICATE_AUTHORITY_OWNER'],
  );
});

test('missing authority, projection, and verifier paths are explicit findings', () => {
  const manifest: AuthorityRoleManifest = {
    schema: 'overcenter-authority-roles',
    schema_version: 1,
    roles: [
      {
        concept: 'missing',
        authority: 'src/missing.ts',
        projections: ['src/missing-view.ts'],
        verifiers: ['test/missing.test.ts'],
      },
    ],
  };
  assert.deepEqual(
    analyzeAuthorityRoles(manifest, () => false).map((finding) => finding.code),
    ['AUTHORITY_PATH_MISSING', 'PROJECTION_PATH_MISSING', 'VERIFIER_PATH_MISSING'],
  );
});

test('declared projection requires a production source reference to its authority', () => {
  const manifest: AuthorityRoleManifest = {
    schema: 'overcenter-authority-roles',
    schema_version: 1,
    roles: [
      {
        concept: 'a',
        authority: 'src/a.ts',
        projections: ['src/view.ts'],
        verifiers: [],
      },
    ],
  };
  const present = new Set(['src/a.ts', 'src/view.ts']);

  assert.deepEqual(
    analyzeAuthorityRoleFlows(
      manifest,
      (path) => present.has(path),
      () => false,
    ),
    [
      {
        code: 'DECLARED_PROJECTION_FLOW_MISSING',
        concept: 'a',
        path: 'src/view.ts',
      },
    ],
  );

  assert.deepEqual(
    analyzeAuthorityRoleFlows(
      manifest,
      (path) => present.has(path),
      (fromPath, toPath) => fromPath === 'src/view.ts' && toPath === 'src/a.ts',
    ),
    [],
  );
});
