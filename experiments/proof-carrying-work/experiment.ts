import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

type Claim = { obligation: string; run: string; revision: string; source: string; generation: number };
type Policy = { writable: string[]; acceptance: string };
type Candidate = {
  claim: Claim;
  changed: string[];
  graph: { nodes: string[]; edges: Array<[string, string]> };
  result: string;
};
type Fact =
  | { kind: 'acceptance'; candidate: string; policy: string; run: string; revision: string; acceptance: string }
  | { kind: 'confinement'; candidate: string; run: string; revision: string; generation: number; substrate: 'controlled' };
type Node =
  | { id: string; rule: 'scope'; changed: string[] }
  | { id: string; rule: 'acyclic'; order: string[] }
  | { id: string; rule: 'acceptance'; fact: string }
  | { id: string; rule: 'confinement'; fact: string }
  | { id: string; rule: 'admissible'; premises: string[] };
type Certificate = { schema: 'overcenter-proof-carrying-work'; candidate: string; policy: string; claim: Claim; nodes: Node[]; root: string };
type Context = { policy: Policy; facts: Map<string, Fact> };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a: unknown, b: unknown): boolean => digest(a) === digest(b);
const clone = <T>(value: T): T => structuredClone(value);

function check(candidate: Candidate, certificate: Certificate, context: Context): boolean {
  if (certificate.schema !== 'overcenter-proof-carrying-work') return false;
  if (certificate.candidate !== digest(candidate) || certificate.policy !== digest(context.policy)) return false;
  if (!same(certificate.claim, candidate.claim) || certificate.nodes.length !== 5) return false;
  const ids = certificate.nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length) return false;
  const conclusions = new Map<string, string>();
  for (const node of certificate.nodes) {
    if (node.rule === 'scope') {
      if (!same(node.changed, candidate.changed)) return false;
      if (!node.changed.every((path) => context.policy.writable.includes(path))) return false;
      conclusions.set(node.id, 'scope');
    } else if (node.rule === 'acyclic') {
      if (node.order.length !== candidate.graph.nodes.length || new Set(node.order).size !== node.order.length) return false;
      if (!same([...node.order].sort(), [...candidate.graph.nodes].sort())) return false;
      const position = new Map(node.order.map((name, index) => [name, index]));
      if (candidate.graph.edges.some(([from, to]) => (position.get(from) ?? Infinity) >= (position.get(to) ?? -1))) return false;
      conclusions.set(node.id, 'graph');
    } else if (node.rule === 'acceptance') {
      const fact = context.facts.get(node.fact);
      if (!fact || fact.kind !== 'acceptance') return false;
      if (fact.candidate !== certificate.candidate || fact.policy !== certificate.policy) return false;
      if (fact.run !== certificate.claim.run || fact.revision !== certificate.claim.revision) return false;
      if (fact.acceptance !== context.policy.acceptance) return false;
      conclusions.set(node.id, 'acceptance');
    } else if (node.rule === 'confinement') {
      const fact = context.facts.get(node.fact);
      if (!fact || fact.kind !== 'confinement') return false;
      if (fact.candidate !== certificate.candidate || fact.run !== certificate.claim.run) return false;
      if (fact.revision !== certificate.claim.revision || fact.generation !== certificate.claim.generation) return false;
      if (fact.substrate !== 'controlled') return false;
      conclusions.set(node.id, 'confinement');
    } else if (node.rule === 'admissible') {
      if (node.id !== certificate.root || node.premises.length !== 4 || new Set(node.premises).size !== 4) return false;
      const actual = node.premises.map((id) => conclusions.get(id)).sort();
      if (!same(actual, ['acceptance', 'confinement', 'graph', 'scope'])) return false;
      conclusions.set(node.id, 'admissible');
    } else return false;
  }
  return conclusions.get(certificate.root) === 'admissible';
}

function control(candidate: Candidate, context: Context): boolean {
  if (!candidate.changed.every((path) => context.policy.writable.includes(path))) return false;
  const nodes = new Set(candidate.graph.nodes);
  if (nodes.size !== candidate.graph.nodes.length) return false;
  const edges = new Map(candidate.graph.nodes.map((node) => [node, [] as string[]]));
  for (const [from, to] of candidate.graph.edges) {
    if (!nodes.has(from) || !nodes.has(to)) return false;
    edges.get(from)?.push(to);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return false;
    if (visited.has(node)) return true;
    visiting.add(node);
    for (const next of edges.get(node) ?? []) if (!visit(next)) return false;
    visiting.delete(node); visited.add(node); return true;
  };
  if (!candidate.graph.nodes.every(visit)) return false;
  const candidateHash = digest(candidate);
  const policyHash = digest(context.policy);
  const facts = [...context.facts.values()];
  const accepted = facts.some((fact) => fact.kind === 'acceptance' && fact.candidate === candidateHash && fact.policy === policyHash && fact.run === candidate.claim.run && fact.revision === candidate.claim.revision && fact.acceptance === context.policy.acceptance);
  const confined = facts.some((fact) => fact.kind === 'confinement' && fact.candidate === candidateHash && fact.run === candidate.claim.run && fact.revision === candidate.claim.revision && fact.generation === candidate.claim.generation && fact.substrate === 'controlled');
  return accepted && confined;
}

function contextFor(candidate: Candidate, policy: Policy, confined = true): Context {
  const candidateHash = digest(candidate);
  const acceptance: Fact = { kind: 'acceptance', candidate: candidateHash, policy: digest(policy), run: candidate.claim.run, revision: candidate.claim.revision, acceptance: policy.acceptance };
  const facts = new Map<string, Fact>([[digest(acceptance), acceptance]]);
  if (confined) {
    const confinement: Fact = { kind: 'confinement', candidate: candidateHash, run: candidate.claim.run, revision: candidate.claim.revision, generation: candidate.claim.generation, substrate: 'controlled' };
    facts.set(digest(confinement), confinement);
  }
  return { policy, facts };
}

function certificateFor(candidate: Candidate, context: Context): Certificate {
  const acceptance = [...context.facts.entries()].find(([, fact]) => fact.kind === 'acceptance');
  const confinement = [...context.facts.entries()].find(([, fact]) => fact.kind === 'confinement');
  assert.ok(acceptance && confinement);
  return {
    schema: 'overcenter-proof-carrying-work', candidate: digest(candidate), policy: digest(context.policy), claim: clone(candidate.claim), root: 'root',
    nodes: [
      { id: 'scope', rule: 'scope', changed: [...candidate.changed] },
      { id: 'graph', rule: 'acyclic', order: [...candidate.graph.nodes] },
      { id: 'acceptance', rule: 'acceptance', fact: acceptance[0] },
      { id: 'confinement', rule: 'confinement', fact: confinement[0] },
      { id: 'root', rule: 'admissible', premises: ['scope', 'graph', 'acceptance', 'confinement'] },
    ],
  };
}

const policy: Policy = { writable: ['src/alpha.ts', 'src/beta.ts'], acceptance: 'source-acceptance-fixture' };
const candidate: Candidate = {
  claim: { obligation: 'source:proof-carrying-work', run: 'run-17', revision: 'authority-abc', source: '0123456789abcdef0123456789abcdef01234567', generation: 7 },
  changed: ['src/alpha.ts'], graph: { nodes: ['prepare', 'verify', 'publish'], edges: [['prepare', 'verify'], ['verify', 'publish']] }, result: 'accepted',
};

type Case = { name: string; candidate: Candidate; certificate: Certificate; context: Context; control: boolean; treatment: boolean };
const base = (): Case => { const c = clone(candidate); const x = contextFor(c, policy); return { name: 'valid', candidate: c, certificate: certificateFor(c, x), context: x, control: true, treatment: true }; };
const cases: Case[] = [base()];
const add = (name: string, mutate: (test: Case) => void, expectedControl = false, expectedTreatment = false): void => { const test = base(); test.name = name; mutate(test); test.control = expectedControl; test.treatment = expectedTreatment; cases.push(test); };

add('candidate substitution', (t) => { t.candidate.result = 'other'; });
add('run substitution', (t) => { t.candidate.claim.run = 'run-18'; });
add('revision substitution', (t) => { t.candidate.claim.revision = 'stale'; });
add('generation substitution', (t) => { t.candidate.claim.generation = 8; });
add('source substitution', (t) => { t.candidate.claim.source = 'fedcba9876543210fedcba9876543210fedcba98'; });
add('policy substitution', (t) => { t.context = { policy: { ...policy, acceptance: 'different' }, facts: t.context.facts }; });
add('out of scope', (t) => { t.candidate.changed.push('src/escape.ts'); });
add('acceptance from other candidate', (t) => { const other = clone(candidate); other.result = 'other'; const wrong = contextFor(other, policy); const confinement = [...t.context.facts.entries()].find(([, fact]) => fact.kind === 'confinement'); assert.ok(confinement); wrong.facts.set(confinement[0], confinement[1]); t.context = wrong; });
add('forged fact reference', (t) => { const node = t.certificate.nodes.find((n) => n.rule === 'acceptance'); assert.ok(node && node.rule === 'acceptance'); node.fact = 'forged'; }, true, false);
add('omitted premise', (t) => { const node = t.certificate.nodes.find((n) => n.rule === 'admissible'); assert.ok(node && node.rule === 'admissible'); node.premises.pop(); }, true, false);
add('unknown proof rule', (t) => { (t.certificate.nodes[0] as unknown as { rule: string }).rule = 'worker-says-safe'; }, true, false);
add('cyclic graph fraudulent witness', (t) => { t.candidate.graph.edges.push(['publish', 'prepare']); t.certificate.candidate = digest(t.candidate); });
add('graph drift after proof', (t) => { t.candidate.graph.nodes.push('audit'); t.candidate.graph.edges.push(['publish', 'audit']); });
add('duplicate proof id', (t) => { t.certificate.nodes[1].id = 'scope'; }, true, false);
add('certificate replay later generation', (t) => { const later = clone(candidate); later.claim.generation = 8; t.candidate = later; t.context = contextFor(later, policy); }, true, false);
add('worker declared confinement', (t) => { t.context = contextFor(candidate, policy, false); const node = t.certificate.nodes.find((n) => n.rule === 'confinement'); assert.ok(node && node.rule === 'confinement'); node.fact = digest({ kind: 'worker-assertion', safe: true }); });
add('ambient provider capability', (t) => { t.context = contextFor(candidate, policy, false); });

let semanticAgreement = 0;
let certificateRejections = 0;
let falseAcceptance = 0;
for (const test of cases) {
  const baseline = control(test.candidate, test.context);
  let treatment = false;
  try { treatment = check(test.candidate, test.certificate, test.context); } catch { treatment = false; }
  assert.equal(baseline, test.control, `control mismatch: ${test.name}`);
  assert.equal(treatment, test.treatment, `treatment mismatch: ${test.name}`);
  if (test.control === test.treatment && baseline === treatment) semanticAgreement += 1;
  if (test.control && !test.treatment && baseline && !treatment) certificateRejections += 1;
  if (treatment && !test.treatment) falseAcceptance += 1;
}
const semanticCases = cases.filter((test) => test.control === test.treatment).length;
const certificateCases = cases.length - semanticCases;
const checkerLines = check.toString().split('\n').filter((line) => line.trim()).length;
assert.equal(semanticAgreement, semanticCases);
assert.equal(certificateRejections, certificateCases);
assert.equal(falseAcceptance, 0);
assert.ok(checkerLines <= 100);

console.log(JSON.stringify({ experiment: 'proof-carrying-work', cases: cases.length, hostile_cases: cases.length - 1, semantic_cases: semanticCases, semantic_control_treatment_agreement: semanticAgreement, certificate_integrity_cases: certificateCases, certificate_integrity_rejected: certificateRejections, false_acceptance: falseAcceptance, checker_nonblank_lines: checkerLines, checker_line_ceiling: 100, worker_assertion_can_establish_effect_confinement: false, ambient_authority_negative_control_rejected: true }));
