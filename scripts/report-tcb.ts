import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { API, SymbolFlags, type Symbol as TypeScriptSymbol } from 'typescript/unstable/sync';
import {
  SyntaxKind,
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isFunctionDeclaration,
  isImportDeclaration,
  isIdentifier,
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

interface SymbolClosure {
  semantic_loc: number;
  files: string[];
  declarations: Array<{
    path: string;
    start_line: number;
    end_line: number;
    semantic_loc: number;
    symbol: string;
  }>;
  external_symbols: string[];
  obligations: string[];
  status: 'candidate' | 'sound';
}

function repoPathFor(node: Node): string | null {
  const fileName = node.getSourceFile().fileName;
  const path = normalizedRepoPath(fileName);
  if (path.startsWith('../') || path === '..' || path.includes('/node_modules/')) return null;
  return path;
}

function checkerFor(node: Node) {
  const project = snapshot.getDefaultProjectForFile(node.getSourceFile().fileName);
  if (!project) throw new Error(`TCB_PROJECT_UNAVAILABLE:${node.getSourceFile().fileName}`);
  return project.checker;
}

function resolvedValueSymbol(node: Node): TypeScriptSymbol | null {
  const checker = checkerFor(node);
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  const resolved = symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (checker.isUnknownSymbol(resolved)) return null;
  return resolved.flags & SymbolFlags.Value ? resolved : null;
}

function lineRange(node: Node): {
  path: string;
  start_line: number;
  end_line: number;
  semantic_loc: number;
} | null {
  const path = repoPathFor(node);
  if (!path) return null;
  const { text, source } = sourceFor(path);
  const start = node.getStart(source);
  const end = node.getEnd();
  const startLine = source.getLineAndCharacterOfPosition(start).line + 1;
  const endLine = source.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1;
  return {
    path,
    start_line: startLine,
    end_line: endLine,
    semantic_loc: text
      .split('\n')
      .slice(startLine - 1, endLine)
      .filter(semanticLine).length,
  };
}

function symbolClosure(entries: SymbolEntry[]): SymbolClosure {
  const queue: Array<{ node: Node; symbol: string }> = entries.map((entry) => {
    const { source } = sourceFor(entry.path);
    return {
      node:
        entry.whole_file === true
          ? source
          : declarationFor(
              entry.path,
              entry.symbol ??
                (() => {
                  throw new Error('TCB_SYMBOL_REQUIRED');
                })(),
            ),
      symbol: entry.whole_file === true ? `${entry.path}#*` : `${entry.path}#${entry.symbol}`,
    };
  });
  const visitedSymbols = new Set<number>();
  const declarations = new Map<
    string,
    {
      path: string;
      start_line: number;
      end_line: number;
      semantic_loc: number;
      symbol: string;
    }
  >();
  const externalSymbols = new Set<string>();
  const obligations = new Set<string>();

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    const range = lineRange(current.node);
    if (range) {
      const key = `${range.path}:${range.start_line}:${range.end_line}`;
      declarations.set(key, { ...range, symbol: current.symbol });
    }

    const visit = (node: Node): void => {
      if (isIdentifier(node)) {
        const symbol = resolvedValueSymbol(node);
        if (symbol && !visitedSymbols.has(symbol.id)) {
          visitedSymbols.add(symbol.id);
          const resolvedDeclarations = symbol.declarations
            .map((handle) => handle.resolve())
            .filter((declaration): declaration is Node => declaration !== undefined);
          const repositoryDeclarations = resolvedDeclarations.filter(
            (declaration) => repoPathFor(declaration) !== null,
          );
          if (repositoryDeclarations.length === 0) {
            externalSymbols.add(symbol.name);
          } else {
            for (const declaration of repositoryDeclarations) {
              queue.push({
                node: declaration,
                symbol: symbol.name,
              });
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(current.node);
  }

  const trusted = new Map<string, Set<number>>();
  for (const declaration of declarations.values()) {
    const { text } = sourceFor(declaration.path);
    const lines = text.split('\n');
    const selected = trusted.get(declaration.path) ?? new Set<number>();
    for (let line = declaration.start_line; line <= declaration.end_line; line += 1) {
      if (semanticLine(lines[line - 1] ?? '')) selected.add(line);
    }
    trusted.set(declaration.path, selected);
  }

  for (const declaration of declarations.values()) {
    const { source } = sourceFor(declaration.path);
    const node = source.statements.find(
      (statement) =>
        source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1 <=
          declaration.start_line &&
        source.getLineAndCharacterOfPosition(
          Math.max(statement.getStart(source), statement.getEnd() - 1),
        ).line +
          1 >=
          declaration.end_line,
    );
    if (node && isInterfaceDeclaration(node)) {
      obligations.add(`TYPE_ONLY_RUNTIME_TARGET:${declaration.path}:${declaration.start_line}`);
    }
  }

  const output = [...declarations.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.start_line - right.start_line ||
      left.end_line - right.end_line,
  );
  return {
    semantic_loc: [...trusted.values()].reduce((sum, lines) => sum + lines.size, 0),
    files: [...trusted.keys()].sort(),
    declarations: output,
    external_symbols: [...externalSymbols].sort(),
    obligations: [...obligations].sort(),
    status: obligations.size === 0 ? 'sound' : 'candidate',
  };
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
      if (statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword) continue;
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

  const text = readFileSync(path, 'utf8');
  const runtimeLoad = /\b(import|require)\s*\(/g;
  for (const match of text.matchAll(runtimeLoad)) {
    const start = match.index;
    const tail = text.slice(start);
    const literal = /^(import|require)\s*\(\s*(['"])([^'"]+)\2\s*\)/.exec(tail);
    if (!literal) {
      throw new Error(
        `${match[1] === 'import' ? 'TCB_DYNAMIC_IMPORT_NONLITERAL' : 'TCB_REQUIRE_NONLITERAL'}:${path}`,
      );
    }
    specifiers.add(literal[3] as string);
  }

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
    const symbols = symbolClosure(property.entries);
    const moduleFiles = new Set(closure.files);
    const symbolFilesOutsideModuleClosure = symbols.files.filter((path) => !moduleFiles.has(path));
    if (symbolFilesOutsideModuleClosure.length > 0) {
      symbols.obligations.push(
        ...symbolFilesOutsideModuleClosure.map((path) => `SYMBOL_OUTSIDE_MODULE_CLOSURE:${path}`),
      );
      symbols.obligations.sort();
      symbols.status = 'candidate';
    }
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
      symbol_closure_status: symbols.status,
      symbol_closure_semantic_loc: symbols.semantic_loc,
      symbol_closure_files: symbols.files,
      symbol_closure_files_outside_module_closure: symbolFilesOutsideModuleClosure,
      symbol_closure_declarations: symbols.declarations,
      symbol_closure_external_symbols: symbols.external_symbols,
      symbol_closure_obligations: symbols.obligations,
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
