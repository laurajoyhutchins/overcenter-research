import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import * as ts from 'typescript';

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

const sourceCache = new Map<string, { text: string; source: ts.SourceFile }>();

function sourceFor(path: string) {
  const cached = sourceCache.get(path);
  if (cached) return cached;
  const text = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const loaded = { text, source };
  sourceCache.set(path, loaded);
  return loaded;
}

function nodeName(node: ts.Node, source: ts.SourceFile): string | null {
  const named = node as ts.Node & { name?: ts.Node };
  if (!named.name) return null;
  return named.name.getText(source);
}

function topLevelNamed(source: ts.SourceFile, name: string): ts.Node | null {
  for (const statement of source.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      nodeName(statement, source) === name
    ) {
      return statement;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(source) === name) return declaration;
      }
    }
  }
  return null;
}

function declarationFor(path: string, symbol: string): ts.Node {
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
  if (!owner || !ts.isClassDeclaration(owner)) {
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

let failed = false;
const reports = policy.properties.map((property) => {
  const slices = property.entries.map(sliceFor);
  const semanticLoc = uniqueSemanticLoc(slices);
  if (semanticLoc > property.max_semantic_loc) failed = true;
  return {
    id: property.id,
    statement: property.statement,
    semantic_loc: semanticLoc,
    max_semantic_loc: property.max_semantic_loc,
    budget_remaining: property.max_semantic_loc - semanticLoc,
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
