import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { API } from 'typescript/unstable/sync';
import {
  SyntaxKind,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isIfStatement,
  isMethodDeclaration,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isStringLiteral,
  isVariableStatement,
  type CallExpression,
  type Expression,
  type MethodDeclaration,
  type Node,
  type SourceFile,
  type Statement,
} from 'typescript/unstable/ast';

export type IssueCode =
  | 'MISSING_MUTATION_AUTHORITY'
  | 'UNVALIDATED_AGENT_FLOW'
  | 'PRODUCTION_EFFECT_WRAPPER_INVALID'
  | 'PRODUCTION_MUTATION_OUTSIDE_WRAPPER';

export interface FlowIssue {
  code: IssueCode;
  line: number;
  detail: string;
}

interface AbstractValue {
  untrusted: boolean;
  validated: boolean;
  exactRevision: boolean;
  currentLease: boolean;
  callTargets: Set<string>;
  properties: Map<string, AbstractValue> | null;
}

interface AnalysisState {
  env: Map<string, AbstractValue>;
  mutationAdmitted: boolean;
}

const blank = (): AbstractValue => ({
  untrusted: false,
  validated: false,
  exactRevision: false,
  currentLease: false,
  callTargets: new Set(),
  properties: null,
});

const cloneValue = (value: AbstractValue): AbstractValue => ({
  ...value,
  callTargets: new Set(value.callTargets),
  properties: value.properties
    ? new Map([...value.properties].map(([key, item]) => [key, cloneValue(item)]))
    : null,
});

const cloneState = (state: AnalysisState): AnalysisState => ({
  env: new Map([...state.env].map(([key, value]) => [key, cloneValue(value)])),
  mutationAdmitted: state.mutationAdmitted,
});

function joinValue(left: AbstractValue, right: AbstractValue): AbstractValue {
  const properties = new Map<string, AbstractValue>();
  const keys = new Set([...(left.properties?.keys() ?? []), ...(right.properties?.keys() ?? [])]);
  for (const key of keys) {
    const a = left.properties?.get(key) ?? blank();
    const b = right.properties?.get(key) ?? blank();
    properties.set(key, joinValue(a, b));
  }
  return {
    untrusted: left.untrusted || right.untrusted,
    validated: left.validated && right.validated,
    exactRevision: left.exactRevision && right.exactRevision,
    currentLease: left.currentLease && right.currentLease,
    callTargets: new Set([...left.callTargets, ...right.callTargets]),
    properties: keys.size ? properties : null,
  };
}

function decayProof(value: AbstractValue): AbstractValue {
  return {
    ...cloneValue(value),
    validated: false,
    exactRevision: false,
    currentLease: false,
  };
}

function lineOf(source: SourceFile, node: Node): number {
  return source.text.slice(0, Math.max(0, node.pos)).split('\n').length;
}

function identifierName(expr: Expression): string | null {
  if (isIdentifier(expr)) return expr.text;
  if (isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function joinMany(values: AbstractValue[]): AbstractValue {
  return values.reduce(joinValue, blank());
}

function assignTarget(target: Expression, value: AbstractValue, state: AnalysisState): void {
  if (isIdentifier(target)) state.env.set(target.text, value);
}

function evalExpression(
  source: SourceFile,
  expr: Expression,
  state: AnalysisState,
  issues: FlowIssue[],
): AbstractValue {
  if (
    isStringLiteral(expr) ||
    isNumericLiteral(expr) ||
    expr.kind === SyntaxKind.TrueKeyword ||
    expr.kind === SyntaxKind.FalseKeyword
  ) {
    return blank();
  }

  if (isIdentifier(expr)) {
    if (expr.text === 'githubMutation') {
      const value = blank();
      value.callTargets.add('githubMutation');
      return value;
    }
    if (expr.text === 'safeNoop') {
      const value = blank();
      value.callTargets.add('safeNoop');
      return value;
    }
    return cloneValue(state.env.get(expr.text) ?? blank());
  }

  if (isObjectLiteralExpression(expr)) {
    const value = blank();
    value.properties = new Map();
    for (const property of expr.properties) {
      if (!isPropertyAssignment(property)) continue;
      const key =
        isIdentifier(property.name) || isStringLiteral(property.name) ? property.name.text : null;
      if (!key) continue;
      value.properties.set(key, evalExpression(source, property.initializer, state, issues));
    }
    return value;
  }

  if (isPropertyAccessExpression(expr)) {
    const object = evalExpression(source, expr.expression, state, issues);
    return cloneValue(object.properties?.get(expr.name.text) ?? blank());
  }

  if (isElementAccessExpression(expr)) {
    const object = evalExpression(source, expr.expression, state, issues);
    if (!object.properties) return blank();
    if (expr.argumentExpression && isStringLiteral(expr.argumentExpression)) {
      return cloneValue(object.properties.get(expr.argumentExpression.text) ?? blank());
    }
    return joinMany([...object.properties.values()]);
  }

  if (isConditionalExpression(expr)) {
    return joinValue(
      evalExpression(source, expr.whenTrue, state, issues),
      evalExpression(source, expr.whenFalse, state, issues),
    );
  }

  if (isBinaryExpression(expr) && expr.operatorToken.kind === SyntaxKind.EqualsToken) {
    const value = evalExpression(source, expr.right, state, issues);
    assignTarget(expr.left, value, state);
    return value;
  }

  if (!isCallExpression(expr)) return blank();

  const direct = identifierName(expr.expression);
  const args = expr.arguments.map((arg) => evalExpression(source, arg, state, issues));

  if (direct === 'untrustedAgentOutput') {
    return { ...blank(), untrusted: true };
  }
  if (direct === 'trustedPayload') return blank();
  if (direct === 'authorityStorePermit') {
    return {
      ...blank(),
      exactRevision: true,
      currentLease: true,
    };
  }
  if (direct === 'historicalPermit') return blank();
  if (direct === 'verifyRevision') {
    const input = cloneValue(args[0] ?? blank());
    input.exactRevision = true;
    return input;
  }
  if (direct === 'verifyLease') {
    const input = cloneValue(args[0] ?? blank());
    input.currentLease = true;
    return input;
  }
  if (direct === 'validateCandidate') {
    const input = cloneValue(args[0] ?? blank());
    input.validated = true;
    return input;
  }
  if (
    direct === 'serialize' ||
    direct === 'deserialize' ||
    direct === 'enqueue' ||
    direct === 'dequeue'
  ) {
    return decayProof(args[0] ?? blank());
  }
  if (direct === 'choose') return joinMany(args);

  const callee = evalExpression(source, expr.expression, state, issues);
  const sink = direct === 'githubMutation' || callee.callTargets.has('githubMutation');
  if (sink) {
    if (!state.mutationAdmitted) {
      issues.push({
        code: 'MISSING_MUTATION_AUTHORITY',
        line: lineOf(source, expr),
        detail: 'GitHub mutation is reachable without admitted mutation authority.',
      });
    }
    for (const arg of args) {
      if (arg.untrusted && !arg.validated) {
        issues.push({
          code: 'UNVALIDATED_AGENT_FLOW',
          line: lineOf(source, expr),
          detail: 'Untrusted agent data can reach GitHub mutation without current validation.',
        });
        break;
      }
    }
    return blank();
  }

  if (direct === 'performEffect') {
    const authority = args[0] ?? blank();
    const admitted = authority.exactRevision && authority.currentLease;
    const callback = expr.arguments[1];
    if (callback && (isArrowFunction(callback) || isFunctionExpression(callback))) {
      const nested = cloneState(state);
      nested.mutationAdmitted = admitted;
      if (isBlock(callback.body)) {
        analyzeStatements(source, callback.body.statements, nested, issues);
      } else {
        evalExpression(source, callback.body, nested, issues);
      }
    }
    return blank();
  }

  return decayProof(joinMany(args));
}

function joinStates(left: AnalysisState, right: AnalysisState): AnalysisState {
  const env = new Map<string, AbstractValue>();
  const keys = new Set([...left.env.keys(), ...right.env.keys()]);
  for (const key of keys) {
    env.set(key, joinValue(left.env.get(key) ?? blank(), right.env.get(key) ?? blank()));
  }
  return {
    env,
    mutationAdmitted: left.mutationAdmitted && right.mutationAdmitted,
  };
}

function analyzeStatement(
  source: SourceFile,
  statement: Statement,
  state: AnalysisState,
  issues: FlowIssue[],
): AnalysisState {
  if (isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (!isIdentifier(declaration.name)) continue;
      const value = declaration.initializer
        ? evalExpression(source, declaration.initializer, state, issues)
        : blank();
      state.env.set(declaration.name.text, value);
    }
    return state;
  }

  if (isExpressionStatement(statement)) {
    evalExpression(source, statement.expression, state, issues);
    return state;
  }

  if (isReturnStatement(statement) && statement.expression) {
    evalExpression(source, statement.expression, state, issues);
    return state;
  }

  if (isBlock(statement)) {
    analyzeStatements(source, statement.statements, state, issues);
    return state;
  }

  if (isIfStatement(statement)) {
    const left = cloneState(state);
    const right = cloneState(state);
    const thenState = analyzeStatement(source, statement.thenStatement, left, issues);
    const elseState = statement.elseStatement
      ? analyzeStatement(source, statement.elseStatement, right, issues)
      : right;
    return joinStates(thenState, elseState);
  }

  return state;
}

function analyzeStatements(
  source: SourceFile,
  statements: readonly Statement[],
  state: AnalysisState,
  issues: FlowIssue[],
): AnalysisState {
  let current = state;
  for (const statement of statements) {
    current = analyzeStatement(source, statement, current, issues);
  }
  return current;
}

function withSource<T>(
  filename: string,
  sourceText: string,
  analyze: (source: SourceFile) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-authority-flow-'));
  const path = join(root, filename);
  writeFileSync(path, sourceText);
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openFiles: [path] });
    try {
      const project = snapshot.getDefaultProjectForFile(path);
      const source = project?.program.getSourceFile(path);
      if (!source) throw new Error('AUTHORITY_FLOW_SOURCE_UNAVAILABLE');
      return analyze(source);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export function analyzeSnippet(sourceText: string): FlowIssue[] {
  return withSource('scenario.ts', sourceText, (source) => {
    const issues: FlowIssue[] = [];
    const scenario = source.statements.find(
      (statement) =>
        isFunctionDeclaration(statement) && statement.name?.text === 'scenario' && !!statement.body,
    );
    const state: AnalysisState = { env: new Map(), mutationAdmitted: false };
    if (scenario && isFunctionDeclaration(scenario) && scenario.body) {
      analyzeStatements(source, scenario.body.statements, state, issues);
    } else {
      analyzeStatements(source, source.statements, state, issues);
    }

    const seen = new Set<string>();
    return issues.filter((issue) => {
      const key = issue.code + ':' + issue.line + ':' + issue.detail;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

function callName(call: CallExpression): string | null {
  return identifierName(call.expression);
}

function containsCall(node: Node, name: string): boolean {
  let found = false;
  const visit = (candidate: Node): void => {
    if (isCallExpression(candidate) && callName(candidate) === name) found = true;
    if (!found) candidate.forEachChild(visit);
  };
  visit(node);
  return found;
}

function methodNamed(source: SourceFile, name: string): MethodDeclaration | null {
  let found: MethodDeclaration | null = null;
  const visit = (node: Node): void => {
    if (
      isMethodDeclaration(node) &&
      ((isIdentifier(node.name) && node.name.text === name) ||
        (isStringLiteral(node.name) && node.name.text === name))
    ) {
      found = node;
      return;
    }
    if (!found) node.forEachChild(visit);
  };
  visit(source);
  return found;
}

function isDirectCallStatement(statement: Statement, name: string): boolean {
  return (
    isExpressionStatement(statement) &&
    isCallExpression(statement.expression) &&
    callName(statement.expression) === name
  );
}

function wrapperIsSound(engine: string): boolean {
  return withSource('engine.ts', engine, (source) => {
    const perform = methodNamed(source, 'performEffect');
    const begin = methodNamed(source, 'beginEffect');
    if (!perform?.body || !begin?.body) return false;

    const statements = [...perform.body.statements];
    const beginIndex = statements.findIndex((statement) =>
      isDirectCallStatement(statement, 'beginEffect'),
    );
    const effectIndex = statements.findIndex((statement) => containsCall(statement, 'effect'));
    if (beginIndex < 0 || effectIndex < 0 || beginIndex >= effectIndex) return false;

    const text = begin.body.getText(source);
    return [
      'projectExecutionAuthority',
      'current_authority',
      'exact_revision',
      'mutationAdmitted',
      'unresolvedReservationsByRun',
    ].every((token) => text.includes(token));
  });
}

function sinkInsidePerformEffect(node: CallExpression): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (isArrowFunction(current) || isFunctionExpression(current)) {
      const parent = current.parent;
      if (
        isCallExpression(parent) &&
        parent.arguments.includes(current) &&
        callName(parent) === 'performEffect'
      )
        return true;
    }
    current = current.parent;
  }
  return false;
}

function providerIssues(filename: string, sourceText: string, sinkName: string): FlowIssue[] {
  return withSource(filename, sourceText, (source) => {
    const issues: FlowIssue[] = [];
    let sinks = 0;
    const visit = (node: Node): void => {
      if (isCallExpression(node) && callName(node) === sinkName) {
        sinks += 1;
        if (!sinkInsidePerformEffect(node)) {
          issues.push({
            code: 'PRODUCTION_MUTATION_OUTSIDE_WRAPPER',
            line: lineOf(source, node),
            detail: filename + ': ' + sinkName + ' is outside performEffect callback.',
          });
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
    if (sinks === 0) {
      issues.push({
        code: 'PRODUCTION_MUTATION_OUTSIDE_WRAPPER',
        line: 1,
        detail: filename + ': expected mutation sink ' + sinkName + ' was not found.',
      });
    }
    return issues;
  });
}

export function analyzeProductionBoundary(input: {
  engine: string;
  githubStatus: string;
  githubPullRequest: string;
}): FlowIssue[] {
  const issues: FlowIssue[] = [];
  if (!wrapperIsSound(input.engine)) {
    issues.push({
      code: 'PRODUCTION_EFFECT_WRAPPER_INVALID',
      line: 1,
      detail: 'performEffect/beginEffect no longer establishes the required authority fence.',
    });
  }
  issues.push(...providerIssues('status-effect.ts', input.githubStatus, 'post'));
  issues.push(...providerIssues('pr-update-branch-effect.ts', input.githubPullRequest, 'put'));
  return issues;
}
