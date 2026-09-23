import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { analyzeProductionBoundary, analyzeSnippet, type IssueCode } from './analyzer.ts';

interface Case {
  name: string;
  source: string;
  expected: IssueCode[];
}

const safe: Case[] = [
  {
    name: 'trusted payload under current authority',
    source: `
function scenario() {
  const permit=authorityStorePermit();
  const payload=trustedPayload();
  performEffect(permit,()=>githubMutation(payload));
}`,
    expected: [],
  },
  {
    name: 'validated agent candidate under current authority',
    source: `
function scenario() {
  const raw=untrustedAgentOutput();
  const candidate=validateCandidate(raw);
  const permit=authorityStorePermit();
  performEffect(permit,()=>githubMutation(candidate));
}`,
    expected: [],
  },
  {
    name: 'queue boundary followed by revalidation',
    source: `
function scenario() {
  const raw=untrustedAgentOutput();
  const first=validateCandidate(raw);
  const queued=enqueue(first);
  const received=dequeue(queued);
  const candidate=validateCandidate(received);
  const permit=authorityStorePermit();
  performEffect(permit,()=>githubMutation(candidate));
}`,
    expected: [],
  },
  {
    name: 'dynamic dispatch remains safe after validation and authority',
    source: `
function scenario(route:string) {
  const raw=untrustedAgentOutput();
  const candidate=validateCandidate(raw);
  const handlers={github:githubMutation,noop:safeNoop};
  const mutate=handlers[route];
  const permit=authorityStorePermit();
  performEffect(permit,()=>mutate(candidate));
}`,
    expected: [],
  },
];

const hostile: Case[] = [
  {
    name: 'raw agent output reaches direct mutation',
    source: `
function scenario() {
  const raw=untrustedAgentOutput();
  githubMutation(raw);
}`,
    expected: ['MISSING_MUTATION_AUTHORITY', 'UNVALIDATED_AGENT_FLOW'],
  },
  {
    name: 'authority wrapper cannot substitute for candidate validation',
    source: `
function scenario() {
  const raw=untrustedAgentOutput();
  const permit=authorityStorePermit();
  performEffect(permit,()=>githubMutation(raw));
}`,
    expected: ['UNVALIDATED_AGENT_FLOW'],
  },
  {
    name: 'candidate validation cannot substitute for mutation authority',
    source: `
function scenario() {
  const candidate=validateCandidate(untrustedAgentOutput());
  githubMutation(candidate);
}`,
    expected: ['MISSING_MUTATION_AUTHORITY'],
  },
  {
    name: 'serialized authority loses current proof',
    source: `
function scenario() {
  const permit=deserialize(serialize(authorityStorePermit()));
  const payload=trustedPayload();
  performEffect(permit,()=>githubMutation(payload));
}`,
    expected: ['MISSING_MUTATION_AUTHORITY'],
  },
  {
    name: 'queued authority loses current proof',
    source: `
function scenario() {
  const permit=dequeue(enqueue(authorityStorePermit()));
  performEffect(permit,()=>githubMutation(trustedPayload()));
}`,
    expected: ['MISSING_MUTATION_AUTHORITY'],
  },
  {
    name: 'serialized candidate must be revalidated',
    source: `
function scenario() {
  const candidate=deserialize(serialize(validateCandidate(untrustedAgentOutput())));
  const permit=authorityStorePermit();
  performEffect(permit,()=>githubMutation(candidate));
}`,
    expected: ['UNVALIDATED_AGENT_FLOW'],
  },
  {
    name: 'queued candidate must be revalidated',
    source: `
function scenario() {
  const candidate=dequeue(enqueue(validateCandidate(untrustedAgentOutput())));
  const permit=authorityStorePermit();
  performEffect(permit,()=>githubMutation(candidate));
}`,
    expected: ['UNVALIDATED_AGENT_FLOW'],
  },
  {
    name: 'aliased mutation sink remains a sink',
    source: `
function scenario() {
  const mutate=githubMutation;
  const raw=untrustedAgentOutput();
  const permit=authorityStorePermit();
  performEffect(permit,()=>mutate(raw));
}`,
    expected: ['UNVALIDATED_AGENT_FLOW'],
  },
  {
    name: 'computed dispatch conservatively includes mutation sink',
    source: `
function scenario(route:string) {
  const handlers={github:githubMutation,noop:safeNoop};
  const mutate=handlers[route];
  const raw=untrustedAgentOutput();
  const permit=authorityStorePermit();
  performEffect(permit,()=>mutate(raw));
}`,
    expected: ['UNVALIDATED_AGENT_FLOW'],
  },
  {
    name: 'branch join remembers unsafe alternative',
    source: `
function scenario(flag:boolean) {
  const raw=untrustedAgentOutput();
  let candidate=raw;
  if (flag) candidate=validateCandidate(raw);
  const permit=authorityStorePermit();
  performEffect(permit,()=>githubMutation(candidate));
}`,
    expected: ['UNVALIDATED_AGENT_FLOW'],
  },
  {
    name: 'exact revision without current lease is insufficient',
    source: `
function scenario() {
  const permit=verifyRevision(historicalPermit());
  performEffect(permit,()=>githubMutation(trustedPayload()));
}`,
    expected: ['MISSING_MUTATION_AUTHORITY'],
  },
  {
    name: 'current lease without exact revision is insufficient',
    source: `
function scenario() {
  const permit=verifyLease(historicalPermit());
  performEffect(permit,()=>githubMutation(trustedPayload()));
}`,
    expected: ['MISSING_MUTATION_AUTHORITY'],
  },
];

const soundEngine = `
class KernelCore {
  reserveEffect(permit:any) {
    const authority=projectExecutionAuthority(run,permit,digest);
    if (!authority.current_authority || !authority.exact_revision) throw new Error('stale');
    if (!mutationAdmitted({...authority,unresolved_effect:history.unresolvedReservationsByRun.has(run.id)})) throw new Error('unresolved');
  }
  async performEffect(permit:any,effect:any) {
    this.reserveEffect(permit);
    return await effect();
  }
}`;

const safeStatus = `
async function status(kernel:any,permit:any,post:any) {
  return kernel.performEffect(permit,async()=>await post(token,path,body));
}`;
const safePullRequest = `
async function update(kernel:any,permit:any,put:any) {
  return kernel.performEffect(permit,async()=>await put(token,path,body));
}`;

const productionMutants = [
  {
    name: 'provider mutation escapes performEffect',
    input: {
      engine: soundEngine,
      githubStatus: `async function status(post:any) { return await post(token,path,body); }`,
      githubPullRequest: safePullRequest,
    },
    expected: 'PRODUCTION_MUTATION_OUTSIDE_WRAPPER' as IssueCode,
  },
  {
    name: 'effect executes before authority fence',
    input: {
      engine: `
class KernelCore {
  reserveEffect(permit:any) {
    const authority=projectExecutionAuthority(run,permit,digest);
    if (!authority.current_authority || !authority.exact_revision) throw new Error('stale');
    if (!mutationAdmitted({...authority,unresolved_effect:history.unresolvedReservationsByRun.has(run.id)})) throw new Error('unresolved');
  }
  async performEffect(permit:any,effect:any) {
    const result=await effect();
    this.reserveEffect(permit);
    return result;
  }
}`,
      githubStatus: safeStatus,
      githubPullRequest: safePullRequest,
    },
    expected: 'PRODUCTION_EFFECT_WRAPPER_INVALID' as IssueCode,
  },
  {
    name: 'reserveEffect loses exact revision fence',
    input: {
      engine: `
class KernelCore {
  reserveEffect(permit:any) {
    const authority=projectExecutionAuthority(run,permit,digest);
    if (!authority.current_authority) throw new Error('stale');
    if (!mutationAdmitted({...authority,unresolved_effect:history.unresolvedReservationsByRun.has(run.id)})) throw new Error('unresolved');
  }
  async performEffect(permit:any,effect:any) {
    this.reserveEffect(permit);
    return await effect();
  }
}`,
      githubStatus: safeStatus,
      githubPullRequest: safePullRequest,
    },
    expected: 'PRODUCTION_EFFECT_WRAPPER_INVALID' as IssueCode,
  },
  {
    name: 'conditional authority fence does not dominate effect',
    input: {
      engine: `
class KernelCore {
  reserveEffect(permit:any) {
    const authority=projectExecutionAuthority(run,permit,digest);
    if (!authority.current_authority || !authority.exact_revision) throw new Error('stale');
    if (!mutationAdmitted({...authority,unresolved_effect:history.unresolvedReservationsByRun.has(run.id)})) throw new Error('unresolved');
  }
  async performEffect(permit:any,effect:any) {
    if (permit) this.reserveEffect(permit);
    return await effect();
  }
}`,
      githubStatus: safeStatus,
      githubPullRequest: safePullRequest,
    },
    expected: 'PRODUCTION_EFFECT_WRAPPER_INVALID' as IssueCode,
  },
];

const started = performance.now();
let classified = 0;
for (const testCase of [...safe, ...hostile]) {
  const issues = analyzeSnippet(testCase.source);
  const codes = new Set(issues.map((issue) => issue.code));
  for (const expected of testCase.expected) {
    assert.ok(
      codes.has(expected),
      testCase.name + ': expected ' + expected + ', got ' + JSON.stringify([...codes]),
    );
  }
  if (testCase.expected.length === 0) {
    assert.deepEqual(issues, [], testCase.name + ': safe control produced diagnostics');
  }
  classified += 1;
}

for (const mutant of productionMutants) {
  const issues = analyzeProductionBoundary(mutant.input);
  assert.ok(
    issues.some((issue) => issue.code === mutant.expected),
    mutant.name + ': expected ' + mutant.expected + ', got ' + JSON.stringify(issues),
  );
}

const productionIssues = analyzeProductionBoundary({
  engine: readFileSync('src/authority/engine.ts', 'utf8'),
  githubStatus: readFileSync('src/providers/github/status-effect.ts', 'utf8'),
  githubPullRequest: readFileSync('src/providers/github/pr-update-branch-effect.ts', 'utf8'),
});
assert.deepEqual(
  productionIssues,
  [],
  'current production mutation boundary must require no suppressions',
);

const elapsed = performance.now() - started;
console.log(
  JSON.stringify(
    {
      cases: classified,
      safe_controls: safe.length,
      hostile_mutants: hostile.length + productionMutants.length,
      hostile_detected: hostile.length + productionMutants.length,
      production_suppressions: 0,
      elapsed_ms: Number(elapsed.toFixed(3)),
    },
    null,
    2,
  ),
);
console.log('PASS: abstract authority-flow analysis');
