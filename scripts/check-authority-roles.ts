#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import {
  analyzeAuthorityRoleFlows,
  analyzeAuthorityRoles,
  type AuthorityRoleManifest,
} from './authority-roles.ts';

const manifest = JSON.parse(readFileSync('authority-roles.json', 'utf8')) as AuthorityRoleManifest;
const findings = [...analyzeAuthorityRoles(manifest), ...analyzeAuthorityRoleFlows(manifest)];

console.log(
  JSON.stringify(
    {
      check: 'authority-roles',
      authority: 'development-tooling-only',
      findings,
    },
    null,
    2,
  ),
);

if (findings.length > 0) process.exitCode = 1;
