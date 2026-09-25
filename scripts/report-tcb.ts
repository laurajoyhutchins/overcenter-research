import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { API, SymbolFlags, type Symbol as TypeScriptSymbol } from 'typescript/unstable/sync';
import {
  SyntaxKind,
  isCallExpression,
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

interface RuntimeDispatchBinding {
  target: string;
  implementation: {
    path: string;
    symbol: string;
  };
  reason: string;
}

interface TcbProperty {
  id: string;
  statement: string;
  max_semantic_loc: number;
  expected_surface_sha256?: string;
  max_module_closure_semantic_loc?: number;
  expected_module_closure_sha256?: string;
  max_hybrid_closure_semantic_loc?: number;
  expected_hybrid_closure_sha256?: string;
  require_sound_symbol_closure?: boolean;
  hostile_evidence_probes?: string[];
  entries: SymbolEntry[];
  composes_with?: string[];
  trusted_symbol_boundaries?: string[];
  runtime_dispatch_bindings?: RuntimeDispatchBinding[];
  external_assumptions: string[];
  excluded: string[];
}

interface TcbComposition {
  id: string;
  statement: string;
  properties: string[];
  max_hybrid_union_semantic_loc?: number;
  expected_hybrid_union_sha256?: string;
}

interface TcbPolicy {
  schema: 'overcenter-tcb-policy';
  schema_version: 1;
  properties: TcbProperty[];
  compositions?: TcbComposition[];
}

interface MutationEvidenceProbe {
  id: string;
  source_blobs: Record<string, string>;
  mutation_score: number;
}

interface MutationEvidence {
  schema: string;
  probes: MutationEvidenceProbe[];
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
const mutationEvidence = JSON.parse(
  readFileSync('experiments/production-criticality-ranking/mutation-evidence.json', 'utf8'),
) as MutationEvidence;
const mutationEvidenceById = new Map(mutationEvidence.probes.map((probe) => [probe.id, probe]));

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

function gitBlobSha1(path: string): string {
  const bytes = readFileSync(path);
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function hostileEvidenceFor(probeIds: readonly string[] | undefined) {
  if (!probeIds || probeIds.length === 0) {
    return { status: 'unconfigured' as const, probes: [] };
  }
  const probes = probeIds.map((id) => {
    const probe = mutationEvidenceById.get(id);
    if (!probe) throw new Error(`TCB_HOSTILE_EVIDENCE_PROBE_UNKNOWN:${id}`);
    const sources = Object.entries(probe.source_blobs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, expected_blob_sha1]) => {
        const current_blob_sha1 = existsSync(path) ? gitBlobSha1(path) : null;
        return {
          path,
          expected_blob_sha1,
          current_blob_sha1,
          current: current_blob_sha1 === expected_blob_sha1,
        };
      });
    return {
      id,
      mutation_score: probe.mutation_score,
      status: sources.every((source) => source.current) ? ('current' as const) : ('stale' as const),
      sources,
    };
  });
  return {
    status: probes.every((probe) => probe.status === 'current')
      ? ('current' as const)
      : ('stale' as const),
    probes,
  };
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
  composed_boundaries: string[];
  resolved_dispatch_bindings: string[];
  status: 'candidate' | 'sound';
}

function isTypeSpaceNode(node: Node): boolean {
  return (
    (node.kind >= SyntaxKind.FirstTypeNode && node.kind <= SyntaxKind.LastTypeNode) ||
    node.kind === SyntaxKind.AnyKeyword ||
    node.kind === SyntaxKind.UnknownKeyword ||
    node.kind === SyntaxKind.NumberKeyword ||
    node.kind === SyntaxKind.BigIntKeyword ||
    node.kind === SyntaxKind.ObjectKeyword ||
    node.kind === SyntaxKind.BooleanKeyword ||
    node.kind === SyntaxKind.StringKeyword ||
    node.kind === SyntaxKind.SymbolKeyword ||
    node.kind === SyntaxKind.VoidKeyword ||
    node.kind === SyntaxKind.UndefinedKeyword ||
    node.kind === SyntaxKind.NeverKeyword ||
    node.kind === SyntaxKind.IntrinsicKeyword ||
    node.kind === SyntaxKind.ExpressionWithTypeArguments
  );
}

function isTypeOnlySpecifier(node: Node): boolean {
  if (node.kind !== SyntaxKind.ImportSpecifier && node.kind !== SyntaxKind.ExportSpecifier) {
    return false;
  }
  return (node as Node & { isTypeOnly?: boolean }).isTypeOnly === true;
}

function repoPathFor(node: Node): string | null {
  const source = node.getSourceFile();
  if (source.isDeclarationFile) return null;
  const path = normalizedRepoPath(source.fileName);
  if (
    path.startsWith('../') ||
    path === '..' ||
    path.startsWith('node_modules/') ||
    path.includes('/node_modules/')
  ) {
    return null;
  }
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

function isInvocationTarget(node: Node): boolean {
  const parent = node.parent;
  if (isCallExpression(parent) && parent.expression === node) return true;
  if (parent.kind === SyntaxKind.PropertyAccessExpression) {
    const access = parent as Node & { name: Node };
    return (
      access.name === node && isCallExpression(parent.parent) && parent.parent.expression === parent
    );
  }
  return false;
}

function hasCallableImplementation(node: Node): boolean {
  if (
    node.kind === SyntaxKind.FunctionDeclaration ||
    node.kind === SyntaxKind.MethodDeclaration ||
    node.kind === SyntaxKind.FunctionExpression ||
    node.kind === SyntaxKind.ArrowFunction
  ) {
    return (node as Node & { body?: Node }).body !== undefined;
  }
  if (
    node.kind === SyntaxKind.VariableDeclaration ||
    node.kind === SyntaxKind.PropertyDeclaration ||
    node.kind === SyntaxKind.PropertyAssignment
  ) {
    return (node as Node & { initializer?: Node }).initializer !== undefined;
  }
  return false;
}

function isRuntimeDeclaration(node: Node): boolean {
  if (node.getSourceFile().isDeclarationFile) return false;
  return !isTypeSpaceNode(node) && !isInterfaceDeclaration(node) && !isTypeAliasDeclaration(node);
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

function symbolClosure(property: TcbProperty): SymbolClosure {
  if ((property.trusted_symbol_boundaries?.length ?? 0) > 0 && !property.composes_with?.length) {
    throw new Error(`TCB_COMPOSITION_REQUIRED:${property.id}`);
  }
  const boundaries = new Set(property.trusted_symbol_boundaries ?? []);
  const dispatchBindings = new Map(
    (property.runtime_dispatch_bindings ?? []).map((binding) => [binding.target, binding]),
  );
  const queue: Array<{ node: Node; symbol: string }> = property.entries.map((entry) => {
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
  const composedBoundaries = new Set<string>();
  const resolvedDispatchBindings = new Set<string>();

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    const range = lineRange(current.node);
    if (range) {
      const key = `${range.path}:${range.start_line}:${range.end_line}`;
      declarations.set(key, { ...range, symbol: current.symbol });
    }

    const visit = (node: Node): void => {
      if (
        isTypeSpaceNode(node) ||
        isInterfaceDeclaration(node) ||
        isTypeAliasDeclaration(node) ||
        (isImportDeclaration(node) &&
          node.importClause?.phaseModifier === SyntaxKind.TypeKeyword) ||
        isTypeOnlySpecifier(node)
      ) {
        return;
      }

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
          const runtimeDeclarations = repositoryDeclarations.filter(isRuntimeDeclaration);
          const declarationKeys = repositoryDeclarations
            .map((declaration) => repoPathFor(declaration))
            .filter((path): path is string => path !== null)
            .map((path) => `${path}#${symbol.name}`);
          const boundaryDeclarations = runtimeDeclarations.filter((declaration) => {
            const path = repoPathFor(declaration);
            return path !== null && boundaries.has(`${path}#${symbol.name}`);
          });
          for (const declaration of boundaryDeclarations) {
            const path = repoPathFor(declaration) as string;
            composedBoundaries.add(`${path}#${symbol.name}`);
          }
          const activeRuntimeDeclarations = runtimeDeclarations.filter(
            (declaration) => !boundaryDeclarations.includes(declaration),
          );
          const dispatchBinding = declarationKeys
            .map((key) => dispatchBindings.get(key))
            .find((binding): binding is RuntimeDispatchBinding => binding !== undefined);

          if (activeRuntimeDeclarations.length > 0) {
            if (
              isInvocationTarget(node) &&
              !activeRuntimeDeclarations.some(hasCallableImplementation)
            ) {
              if (dispatchBinding) {
                queue.push({
                  node: declarationFor(
                    dispatchBinding.implementation.path,
                    dispatchBinding.implementation.symbol,
                  ),
                  symbol: dispatchBinding.implementation.symbol,
                });
                resolvedDispatchBindings.add(
                  `${dispatchBinding.target}->${dispatchBinding.implementation.path}#${dispatchBinding.implementation.symbol}`,
                );
              } else {
                const targets = [
                  ...new Set(
                    activeRuntimeDeclarations
                      .map((declaration) => repoPathFor(declaration))
                      .filter((path): path is string => path !== null),
                  ),
                ].sort();
                obligations.add(
                  `DYNAMIC_CALL_TARGET_UNRESOLVED:${symbol.name}:${targets.join(',')}`,
                );
              }
            }
            for (const declaration of activeRuntimeDeclarations) {
              queue.push({
                node: declaration,
                symbol: symbol.name,
              });
            }
          } else if (boundaryDeclarations.length > 0) {
            // The implementation is deliberately supplied by a separately measured TCB property.
          } else if (repositoryDeclarations.length > 0 && dispatchBinding) {
            queue.push({
              node: declarationFor(
                dispatchBinding.implementation.path,
                dispatchBinding.implementation.symbol,
              ),
              symbol: dispatchBinding.implementation.symbol,
            });
            resolvedDispatchBindings.add(
              `${dispatchBinding.target}->${dispatchBinding.implementation.path}#${dispatchBinding.implementation.symbol}`,
            );
          } else if (repositoryDeclarations.length > 0) {
            const targets = [...new Set(declarationKeys.map((key) => key.split('#')[0]))].sort();
            obligations.add(`DYNAMIC_DISPATCH_UNRESOLVED:${symbol.name}:${targets.join(',')}`);
          } else {
            externalSymbols.add(symbol.name);
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
    composed_boundaries: [...composedBoundaries].sort(),
    resolved_dispatch_bindings: [...resolvedDispatchBindings].sort(),
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

interface HybridClosure {
  semantic_loc: number;
  files: string[];
  sha256: string;
}

function hybridClosure(
  module: ModuleClosure,
  symbols: SymbolClosure,
  property: TcbProperty,
): HybridClosure {
  const trusted = new Map<string, Set<number>>();
  const fingerprintMaterial = [`module:${module.sha256}`];
  const moduleFiles = new Set(module.files);

  for (const path of module.files) {
    const { text } = sourceFor(path);
    const selected = trusted.get(path) ?? new Set<number>();
    text.split('\n').forEach((line, index) => {
      if (semanticLine(line)) selected.add(index + 1);
    });
    trusted.set(path, selected);
  }

  for (const declaration of symbols.declarations) {
    const { text } = sourceFor(declaration.path);
    const lines = text.split('\n');
    const selected = trusted.get(declaration.path) ?? new Set<number>();
    for (let line = declaration.start_line; line <= declaration.end_line; line += 1) {
      if (semanticLine(lines[line - 1] ?? '')) selected.add(line);
    }
    trusted.set(declaration.path, selected);

    if (!moduleFiles.has(declaration.path)) {
      const source = sourceFor(declaration.path).source;
      const start = source.getPositionOfLineAndCharacter(declaration.start_line - 1, 0);
      const end =
        declaration.end_line < lines.length
          ? source.getPositionOfLineAndCharacter(declaration.end_line, 0)
          : text.length;
      const body = text.slice(start, end);
      fingerprintMaterial.push(
        `symbol:${declaration.path}:${declaration.start_line}-${declaration.end_line}:${createHash('sha256').update(body).digest('hex')}`,
      );
    }
  }

  for (const boundary of symbols.composed_boundaries) {
    fingerprintMaterial.push(`composition:${boundary}`);
  }
  for (const binding of symbols.resolved_dispatch_bindings) {
    fingerprintMaterial.push(`dispatch:${binding}`);
  }
  for (const propertyId of property.composes_with ?? []) {
    fingerprintMaterial.push(`composes-with:${propertyId}`);
  }

  return {
    semantic_loc: [...trusted.values()].reduce((sum, lines) => sum + lines.size, 0),
    files: [...trusted.keys()].sort(),
    sha256: createHash('sha256').update(fingerprintMaterial.sort().join('\n')).digest('hex'),
  };
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
    const symbols = symbolClosure(property);
    const hybrid = hybridClosure(closure, symbols, property);
    const moduleFiles = new Set(closure.files);
    const symbolFilesOutsideModuleClosure = symbols.files.filter((path) => !moduleFiles.has(path));
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
    if (
      property.max_hybrid_closure_semantic_loc !== undefined &&
      hybrid.semantic_loc > property.max_hybrid_closure_semantic_loc
    ) {
      failed = true;
    }
    if (
      property.expected_hybrid_closure_sha256 &&
      property.expected_hybrid_closure_sha256 !== hybrid.sha256
    ) {
      failed = true;
    }
    if (property.require_sound_symbol_closure && symbols.status !== 'sound') {
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
      require_sound_symbol_closure: property.require_sound_symbol_closure ?? false,
      hybrid_closure_semantic_loc: hybrid.semantic_loc,
      max_hybrid_closure_semantic_loc: property.max_hybrid_closure_semantic_loc ?? null,
      hybrid_closure_sha256: hybrid.sha256,
      expected_hybrid_closure_sha256: property.expected_hybrid_closure_sha256 ?? null,
      hybrid_closure_files: hybrid.files,
      symbol_closure_files: symbols.files,
      symbol_closure_files_outside_module_closure: symbolFilesOutsideModuleClosure,
      symbol_closure_declarations: symbols.declarations,
      symbol_closure_external_symbols: symbols.external_symbols,
      symbol_closure_obligations: symbols.obligations,
      symbol_closure_composed_boundaries: symbols.composed_boundaries,
      symbol_closure_resolved_dispatch_bindings: symbols.resolved_dispatch_bindings,
      composes_with: property.composes_with ?? [],
      hostile_evidence: hostileEvidenceFor(property.hostile_evidence_probes),
      slices,
      external_assumptions: property.external_assumptions,
      excluded: property.excluded,
    };
  });

  const compositions = (policy.compositions ?? []).map((composition) => {
    const members = composition.properties.map((id) => {
      const member = reports.find((candidate) => candidate.id === id);
      if (!member) throw new Error(`TCB_COMPOSITION_PROPERTY_UNKNOWN:${composition.id}:${id}`);
      return member;
    });
    const trusted = new Map<string, Set<number>>();
    for (const member of members) {
      for (const path of member.module_closure_files) {
        const lines = readFileSync(path, 'utf8').split('\n');
        const selected = trusted.get(path) ?? new Set<number>();
        lines.forEach((line, index) => {
          if (semanticLine(line)) selected.add(index + 1);
        });
        trusted.set(path, selected);
      }
      const moduleFiles = new Set(member.module_closure_files);
      for (const declaration of member.symbol_closure_declarations) {
        if (moduleFiles.has(declaration.path)) continue;
        const lines = readFileSync(declaration.path, 'utf8').split('\n');
        const selected = trusted.get(declaration.path) ?? new Set<number>();
        for (let line = declaration.start_line; line <= declaration.end_line; line += 1) {
          if (semanticLine(lines[line - 1] ?? '')) selected.add(line);
        }
        trusted.set(declaration.path, selected);
      }
    }
    const fingerprintMaterial = [`composition:${composition.id}`];
    for (const member of [...composition.properties].sort()) fingerprintMaterial.push(`member:${member}`);
    for (const path of [...trusted.keys()].sort()) {
      const lines = readFileSync(path, 'utf8').split('\n');
      for (const line of [...(trusted.get(path) ?? [])].sort((left, right) => left - right)) {
        fingerprintMaterial.push(`${path}:${line}:${lines[line - 1] ?? ''}`);
      }
    }
    const semanticLoc = [...trusted.values()].reduce((sum, lines) => sum + lines.size, 0);
    const sha256 = createHash('sha256').update(fingerprintMaterial.join('\n')).digest('hex');
    if (
      composition.max_hybrid_union_semantic_loc !== undefined &&
      semanticLoc > composition.max_hybrid_union_semantic_loc
    ) {
      failed = true;
    }
    if (
      composition.expected_hybrid_union_sha256 &&
      composition.expected_hybrid_union_sha256 !== sha256
    ) {
      failed = true;
    }
    const memberEvidence = members.map((member) => member.hostile_evidence);
    const hostileEvidenceStatus = memberEvidence.some((evidence) => evidence.status === 'stale')
      ? 'stale'
      : memberEvidence.some((evidence) => evidence.status === 'unconfigured')
        ? 'incomplete'
        : 'current';
    return {
      id: composition.id,
      statement: composition.statement,
      properties: composition.properties,
      hybrid_union_semantic_loc: semanticLoc,
      max_hybrid_union_semantic_loc: composition.max_hybrid_union_semantic_loc ?? null,
      hybrid_union_sha256: sha256,
      expected_hybrid_union_sha256: composition.expected_hybrid_union_sha256 ?? null,
      hybrid_union_files: [...trusted.keys()].sort(),
      hostile_evidence_status: hostileEvidenceStatus,
    };
  });

  const report = {
    schema: 'overcenter-tcb-report',
    schema_version: 1,
    generated_from_policy: 'tcb-policy.json',
    properties: reports,
    compositions,
  };
  if (failed) {
    console.error(
      JSON.stringify(
        {
          check: 'tcb-ratchet-mismatch',
          properties: reports.map((property) => ({
            id: property.id,
            semantic_loc: property.semantic_loc,
            max_semantic_loc: property.max_semantic_loc,
            surface_sha256: property.surface_sha256,
            expected_surface_sha256: property.expected_surface_sha256,
            module_closure_semantic_loc: property.module_closure_semantic_loc,
            max_module_closure_semantic_loc: property.max_module_closure_semantic_loc,
            module_closure_sha256: property.module_closure_sha256,
            expected_module_closure_sha256: property.expected_module_closure_sha256,
            symbol_closure_status: property.symbol_closure_status,
            hybrid_closure_semantic_loc: property.hybrid_closure_semantic_loc,
            max_hybrid_closure_semantic_loc: property.max_hybrid_closure_semantic_loc,
            hybrid_closure_sha256: property.hybrid_closure_sha256,
            expected_hybrid_closure_sha256: property.expected_hybrid_closure_sha256,
          })),
          compositions: compositions.map((composition) => ({
            id: composition.id,
            hybrid_union_semantic_loc: composition.hybrid_union_semantic_loc,
            max_hybrid_union_semantic_loc: composition.max_hybrid_union_semantic_loc,
            hybrid_union_sha256: composition.hybrid_union_sha256,
            expected_hybrid_union_sha256: composition.expected_hybrid_union_sha256,
            hostile_evidence_status: composition.hostile_evidence_status,
          })),
        },
        null,
        2,
      ),
    );
  }
  console.log(JSON.stringify(report, null, 2));

  if (failed) {
    throw new Error('TCB_BUDGET_EXCEEDED');
  }
} finally {
  snapshot.dispose();
  api.close();
}
