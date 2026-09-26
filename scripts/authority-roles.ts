import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { API } from 'typescript/unstable/sync';
import { isExportDeclaration, isImportDeclaration, isStringLiteral } from 'typescript/unstable/ast';

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
    | 'AUTHORITY_ALSO_PROJECTION'
    | 'DECLARED_PROJECTION_FLOW_MISSING';
  concept: string;
  path?: string;
}

export type ProductionReferenceProbe = (fromPath: string, toPath: string) => boolean;

function validateManifestSchema(manifest: AuthorityRoleManifest): void {
  if (manifest.schema !== 'overcenter-authority-roles' || manifest.schema_version !== 1) {
    throw new Error('AUTHORITY_ROLE_MANIFEST_SCHEMA_UNSUPPORTED');
  }
}

function sortFindings(findings: AuthorityRoleFinding[]): AuthorityRoleFinding[] {
  return findings.sort((left, right) =>
    [left.code, left.concept, left.path ?? '']
      .join(':')
      .localeCompare([right.code, right.concept, right.path ?? ''].join(':')),
  );
}

function normalizedRepoPath(path: string): string {
  return relative(process.cwd(), resolve(path)).replaceAll('\\', '/');
}

function resolveLocalReference(fromPath: string, specifier: string): string | null {
  const base = resolve(dirname(resolve(fromPath)), specifier);
  const candidates = [
    base,
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : '',
    `${base}.ts`,
    resolve(base, 'index.ts'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? normalizedRepoPath(found) : null;
}

function productionReferenceProbe(manifest: AuthorityRoleManifest): ProductionReferenceProbe {
  const paths = [
    ...new Set(
      manifest.roles.flatMap((role) =>
        role.projections.length > 0 ? [role.authority, ...role.projections] : [],
      ),
    ),
  ].filter((path) => existsSync(path));
  const edges = new Set<string>();
  if (paths.length === 0) return () => false;

  const api = new API({ cwd: process.cwd() });
  const snapshot = api.updateSnapshot({ openFiles: paths.map((path) => resolve(path)) });
  try {
    for (const path of paths) {
      const absolute = resolve(path);
      const project = snapshot.getDefaultProjectForFile(absolute);
      const source = project?.program.getSourceFile(absolute);
      if (!source) throw new Error(`AUTHORITY_ROLE_SOURCE_UNAVAILABLE:${path}`);

      for (const statement of source.statements) {
        const moduleSpecifier = isImportDeclaration(statement)
          ? statement.moduleSpecifier
          : isExportDeclaration(statement)
            ? statement.moduleSpecifier
            : undefined;
        if (!moduleSpecifier || !isStringLiteral(moduleSpecifier)) continue;
        if (!moduleSpecifier.text.startsWith('.')) continue;

        const target = resolveLocalReference(path, moduleSpecifier.text);
        if (target) edges.add(`${path}\0${target}`);
      }
    }
  } finally {
    snapshot.dispose();
    api.close();
  }

  return (fromPath, toPath) => edges.has(`${fromPath}\0${toPath}`);
}

export function analyzeAuthorityRoles(
  manifest: AuthorityRoleManifest,
  pathExists: (path: string) => boolean = existsSync,
): AuthorityRoleFinding[] {
  validateManifestSchema(manifest);

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

  return sortFindings(findings);
}

export function analyzeAuthorityRoleFlows(
  manifest: AuthorityRoleManifest,
  pathExists: (path: string) => boolean = existsSync,
  hasProductionReference?: ProductionReferenceProbe,
): AuthorityRoleFinding[] {
  validateManifestSchema(manifest);
  const references = hasProductionReference ?? productionReferenceProbe(manifest);
  const findings: AuthorityRoleFinding[] = [];

  for (const role of manifest.roles) {
    for (const projection of role.projections) {
      if (projection === role.authority || !pathExists(role.authority) || !pathExists(projection)) {
        continue;
      }

      if (!references(role.authority, projection) && !references(projection, role.authority)) {
        findings.push({
          code: 'DECLARED_PROJECTION_FLOW_MISSING',
          concept: role.concept,
          path: projection,
        });
      }
    }
  }

  return sortFindings(findings);
}
