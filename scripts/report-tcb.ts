import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { API } from 'typescript/unstable/sync';
import {
  SyntaxKind,
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
  type Node,
  type SourceFile,
} from 'typescript/unstable/ast';

interface SymbolEntry {
  path: string;
  symbol?: string;
  whole_file?: boolean;
  reason: string;
}

interface TcbProperty {
  id: string;
  statement: string;
  max_semantic_loc: number;
  expected_surface_sha256?: string;
  max_module_closure_semantic_loc?: number;
  expected_module_closure_sha256?: string;
  entries: SymbolEntry[];
  external_assumptions: string[];
  excluded: string[];
}

interface TcbPolicy {
  schema: 'overcenter-tcb-policy';
  schema_version: 1;
  properties: TcbProperty[];
}

interface Slice {
  path: string;
  symbol: string;
  reason: string;
  start_line: number;
  end_line: number;
  physical_loc: number;
  semantic_loc: number;
  sha256: string;
}

const policy = JSON.parse(readFileSync('tcb-policy.json', 'utf8')) as TcbPolicy;
if (policy.schema !== 'overcenter-tcb-policy' || policy.schema_version !== 1) {
  throw new Error('TCB_POLICY_SCHEMA_UNSUPPORTED');
}

const openFiles = [
  ...new Set(
    policy.properties.flatMap((property) => property.entries.map((entry) => resolve(entry.path))),
  ),
];
const api = new API({ cwd: process.cwd() });
const snapshot = api.updateSnapshot({ openFiles });
const sourceCache = new Map<string, { text: string; source: SourceFile }>();

function sourceFor(path: string) {
  const cached = sourceCache.get(path);
  if (cached) return cached;
  const absolute = resolve(path);
  const project = snapshot.getDefaultProjectForFile(absolute);
  const source = project?.program.getSourceFile(absolute);
  if (!source) throw new Error(`TCB_SOURCE_UNAVAILABLE:${path}`);
  const text = readFileSync(path, 'utf8');
  const loaded = { text, source };
  sourceCache.set(path, loaded);
  return loaded;
}

function nodeName(node: Node, source: SourceFile): string | null {
  const named = node as Node & { name?: Node };
  if (!named.name) return null;
  return named.name.getText(source);
}

function topLevelNamed(source: SourceFile, name: string): Node | null {
  for (const statement of source.statements) {
    if (
      (isFunctionDeclaration(statement) ||
        isClassDeclaration(statement) ||
        isInterfaceDeclaration(statement) ||
        isTypeAliasDeclaration(statement) ||
        isEnumDeclaration(statement)) &&
      nodeName(statement, source) === name
    ) {
      return statement;
    }
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(source) === name) return declaration;
      }
    }
  }
  return null;
}

function declarationFor(path: string, symbol: string): Node {
  const { source } = sourceFor(path);
  const dot = symbol.indexOf('.');
  if (dot < 0) {
    const found = topLevelNamed(source, symbol);
    if (!found) throw new Error(`TCB_SYMBOL_NOT_FOUND:${path}#${symbol}`);
    return found;
  }

  const ownerName = symbol.slice(0, dot);
  const memberName = symbol.slice(dot + 1);
  const owner = topLevelNamed(source, ownerName);
  if (!owner || !isClassDeclaration(owner)) {
    throw new Error(`TCB_OWNER_NOT_FOUND:${path}#${ownerName}`);
  }
  for (const member of owner.members) {
    if (nodeName(member, source) === memberName) return member;
  }
  throw new Error(`TCB_MEMBER_NOT_FOUND:${path}#${symbol}`);
}

function semanticLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('//') &&
    !trimmed.startsWith('/*') &&
    !trimmed.startsWith('*') &&
    !trimmed.startsWith('*/')
  );
}

function sliceFor(entry: SymbolEntry): Slice {
  const { text, source } = sourceFor(entry.path);
  const node =
    entry.whole_file === true
      ? source
      : declarationFor(
          entry.path,
          entry.symbol ??
            (() => {
              throw new Error('TCB_SYMBOL_REQUIRED');
            })(),
        );
  const start = entry.whole_file === true ? 0 : node.getStart(source);
  const end = entry.whole_file === true ? text.length : node.getEnd();
  const startLine = source.getLineAndCharacterOfPosition(start).line + 1;
  const endLine = source.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1;
  const selected = text.slice(start, end);
  const lines = selected.split('\n');
  return {
    path: entry.path,
    symbol: entry.whole_file === true ? '*' : (entry.symbol as string),
    reason: entry.reason,
    start_line: startLine,
    end_line: endLine,
    physical_loc: endLine - startLine + 1,
    semantic_loc: lines.filter(semanticLine).length,
    sha256: createHash('sha256').update(selected).digest('hex'),
  };
}

function uniqueSemanticLoc(slices: Slice[]): number {
  const trusted = new Map<string, Set<number>>();
  for (const slice of slices) {
    const { text } = sourceFor(slice.path);
    const lines = text.split('\n');
    const selected = trusted.get(slice.path) ?? new Set<number>();
    for (let line = slice.start_line; line <= slice.end_line; line += 1) {
      if (semanticLine(lines[line - 1] ?? '')) selected.add(line);
    }
    trusted.set(slice.path, selected);
  }
  return [...trusted.values()].reduce((sum, lines) => sum + lines.size, 0);
}

interface ModuleClosure {
  files: string[];
  semantic_loc: number;
  bytes: number;
  sha256: string;
  external_modules: string[];
}

function normalizedRepoPath(path: string): string {
  return relative(process.cwd(), resolve(path)).replaceAll('\\\\', '/');
}

function resolveLocalImport(fromPath: string, specifier: string): string {
  const base = resolve(dirname(resolve(fromPath)), specifier);
  const candidates = [
    base,
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : '',
    `${base}.ts`,
    resolve(base, 'index.ts'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`TCB_LOCAL_IMPORT_UNRESOLVED:${fromPath}:${specifier}`);
  return normalizedRepoPath(found);
}

function runtimeImports(path: string): { local: string[]; external: string[] } {
  const { source } = sourceFor(path);
  const specifiers = new Set<string>();

  const addModuleSpecifier = (node: Node | undefined, error: string): void => {
    if (!node || !isStringLiteral(node)) throw new Error(`${error}:${path}`);
    specifiers.add(node.text);
  };

  for (const statement of source.statements) {
    if (isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) continue;
      addModuleSpecifier(statement.moduleSpecifier, 'TCB_IMPORT_SPECIFIER_NONLITERAL');
      continue;
    }
    if (isExportDeclaration(statement)) {
      if (statement.isTypeOnly || !statement.moduleSpecifier) continue;
      addModuleSpecifier(statement.moduleSpecifier, 'TCB_EXPORT_SPECIFIER_NONLITERAL');
      continue;
    }
    if (statement.kind === SyntaxKind.ImportEqualsDeclaration) {
      throw new Error(`TCB_IMPORT_EQUALS_UNSUPPORTED:${path}`);
    }
  }

  const visitRuntimeLoads = (node: Node): void => {
    if (isCallExpression(node)) {
      const dynamicImport = node.expression.kind === SyntaxKind.ImportKeyword;
      const commonJsRequire = isIdentifier(node.expression) && node.expression.text === 'require';
      if (dynamicImport || commonJsRequire) {
        if (node.arguments.length !== 1 || !isStringLiteral(node.arguments[0])) {
          throw new Error(
            `${dynamicImport ? 'TCB_DYNAMIC_IMPORT_NONLITERAL' : 'TCB_REQUIRE_NONLITERAL'}:${path}`,
          );
        }
        specifiers.add(node.arguments[0].text);
      }
    }
    for (const child of node.getChildren(source)) visitRuntimeLoads(child);
  };
  visitRuntimeLoads(source);

  const local: string[] = [];
  const external: string[] = [];
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) local.push(resolveLocalImport(path, specifier));
    else external.push(specifier);
  }
  return { local, external };
}

function moduleClosure(rootPaths: string[]): ModuleClosure {
  const pending = [...new Set(rootPaths.map(normalizedRepoPath))];
  const visited = new Set<string>();
  const external = new Set<string>();

  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const imports = runtimeImports(path);
    for (const module of imports.external) external.add(module);
    for (const dependency of imports.local) {
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }

  const files = [...visited].sort();
  let semanticLoc = 0;
  let bytes = 0;
  const hashes: string[] = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    semanticLoc += text.split('\n').filter(semanticLine).length;
    bytes += Buffer.byteLength(text);
    hashes.push(`${path}:${createHash('sha256').update(text).digest('hex')}`);
  }

  return {
    files,
    semantic_loc: semanticLoc,
    bytes,
    sha256: createHash('sha256').update(hashes.join('\n')).digest('hex'),
    external_modules: [...external].sort(),
  };
}

try {
  let failed = false;
  const reports = policy.properties.map((property) => {
    const slices = property.entries.map(sliceFor);
    const semanticLoc = uniqueSemanticLoc(slices);
    const surfaceSha256 = createHash('sha256')
      .update(
        slices
          .map((slice) => `${slice.path}#${slice.symbol}:${slice.sha256}`)
          .sort()
          .join('\n'),
      )
      .digest('hex');
    const closure = moduleClosure(property.entries.map((entry) => entry.path));
    if (semanticLoc > property.max_semantic_loc) failed = true;
    if (property.expected_surface_sha256 && property.expected_surface_sha256 !== surfaceSha256) {
      failed = true;
    }
    if (
      property.max_module_closure_semantic_loc !== undefined &&
      closure.semantic_loc > property.max_module_closure_semantic_loc
    ) {
      failed = true;
    }
    if (
      property.expected_module_closure_sha256 &&
      property.expected_module_closure_sha256 !== closure.sha256
    ) {
      failed = true;
    }
    return {
      id: property.id,
      statement: property.statement,
      semantic_loc: semanticLoc,
      max_semantic_loc: property.max_semantic_loc,
      budget_remaining: property.max_semantic_loc - semanticLoc,
      surface_sha256: surfaceSha256,
      expected_surface_sha256: property.expected_surface_sha256 ?? null,
      module_closure_semantic_loc: closure.semantic_loc,
      max_module_closure_semantic_loc: property.max_module_closure_semantic_loc ?? null,
      module_closure_bytes: closure.bytes,
      module_closure_sha256: closure.sha256,
      expected_module_closure_sha256: property.expected_module_closure_sha256 ?? null,
      module_closure_files: closure.files,
      external_module_imports: closure.external_modules,
      slices,
      external_assumptions: property.external_assumptions,
      excluded: property.excluded,
    };
  });

  const report = {
    schema: 'overcenter-tcb-report',
    schema_version: 1,
    generated_from_policy: 'tcb-policy.json',
    properties: reports,
  };
  console.log(JSON.stringify(report, null, 2));

  if (failed) {
    throw new Error('TCB_BUDGET_EXCEEDED');
  }
} finally {
  snapshot.dispose();
  api.close();
}
