import { existsSync } from 'node:fs';

export interface AuthorityRole {
  concept: string;
  authority: string;
  projections: string[];
  verifiers: string[];
}

export interface AuthorityRoleManifest {
  schema: 'overcenter-authority-roles';
  schema_version: 1;
  roles: AuthorityRole[];
}

export interface AuthorityRoleFinding {
  code:
    | 'DUPLICATE_CONCEPT'
    | 'DUPLICATE_AUTHORITY_OWNER'
    | 'AUTHORITY_PATH_MISSING'
    | 'PROJECTION_PATH_MISSING'
    | 'VERIFIER_PATH_MISSING'
    | 'AUTHORITY_ALSO_PROJECTION';
  concept: string;
  path?: string;
}

export function analyzeAuthorityRoles(
  manifest: AuthorityRoleManifest,
  pathExists: (path: string) => boolean = existsSync,
): AuthorityRoleFinding[] {
  if (manifest.schema !== 'overcenter-authority-roles' || manifest.schema_version !== 1) {
    throw new Error('AUTHORITY_ROLE_MANIFEST_SCHEMA_UNSUPPORTED');
  }

  const findings: AuthorityRoleFinding[] = [];
  const concepts = new Set<string>();
  const owners = new Map<string, string>();

  for (const role of manifest.roles) {
    if (!role.concept || !role.authority) throw new Error('AUTHORITY_ROLE_INVALID');

    if (concepts.has(role.concept)) {
      findings.push({ code: 'DUPLICATE_CONCEPT', concept: role.concept });
    }
    concepts.add(role.concept);

    const existingOwner = owners.get(role.authority);
    if (existingOwner && existingOwner !== role.concept) {
      findings.push({
        code: 'DUPLICATE_AUTHORITY_OWNER',
        concept: role.concept,
        path: role.authority,
      });
    } else {
      owners.set(role.authority, role.concept);
    }

    if (!pathExists(role.authority)) {
      findings.push({
        code: 'AUTHORITY_PATH_MISSING',
        concept: role.concept,
        path: role.authority,
      });
    }

    for (const projection of role.projections) {
      if (projection === role.authority) {
        findings.push({
          code: 'AUTHORITY_ALSO_PROJECTION',
          concept: role.concept,
          path: projection,
        });
      }
      if (!pathExists(projection)) {
        findings.push({
          code: 'PROJECTION_PATH_MISSING',
          concept: role.concept,
          path: projection,
        });
      }
    }

    for (const verifier of role.verifiers) {
      if (!pathExists(verifier)) {
        findings.push({
          code: 'VERIFIER_PATH_MISSING',
          concept: role.concept,
          path: verifier,
        });
      }
    }
  }

  return findings.sort((left, right) =>
    [left.code, left.concept, left.path ?? '']
      .join(':')
      .localeCompare([right.code, right.concept, right.path ?? ''].join(':')),
  );
}
