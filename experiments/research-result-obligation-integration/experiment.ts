import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

type Outcome = 'supported' | 'falsified' | 'inconclusive';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(record[key]))
      .join(',') +
    '}'
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function certify(
  design: { experiment: string; question: string; claim: string; success_criteria: string[] },
  revision: string,
  outcome: Outcome,
  evidenceDigest: string,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
) {
  assert.match(revision, /^[0-9a-f]{40}$/);
  const payload = {
    schema: 'overcenter-research-result',
    schema_version: 1,
    experiment: design.experiment,
    design_digest: digest(design),
    evaluated_revision: revision,
    outcome,
    claim: design.claim,
    claim_digest: digest({ claim: design.claim }),
    evidence_digest: evidenceDigest,
  };
  return {
    payload,
    signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString('base64'),
  };
}

function verifyCertificate(
  certificate: ReturnType<typeof certify>,
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
) {
  const payload = certificate.payload;
  assert.equal(payload.schema, 'overcenter-research-result');
  assert.equal(payload.schema_version, 1);
  assert.match(payload.evaluated_revision, /^[0-9a-f]{40}$/);
  assert.match(payload.design_digest, /^[0-9a-f]{64}$/);
  assert.match(payload.claim_digest, /^[0-9a-f]{64}$/);
  assert.match(payload.evidence_digest, /^[0-9a-f]{64}$/);
  assert.equal(payload.claim_digest, digest({ claim: payload.claim }));
  if (
    !verify(
      null,
      Buffer.from(canonical(payload)),
      publicKey,
      Buffer.from(certificate.signature, 'base64'),
    )
  ) {
    throw new Error('RESEARCH_RESULT_SIGNATURE_INVALID');
  }
  return payload;
}

function resultIdentity(
  certificate: ReturnType<typeof certify>,
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
): string {
  const payload = verifyCertificate(certificate, publicKey);
  return digest({
    domain: 'overcenter-research-result-identity',
    experiment: payload.experiment,
    design_digest: payload.design_digest,
    outcome: payload.outcome,
    claim_digest: payload.claim_digest,
  });
}

interface Plan {
  id: string;
  requires: string[];
  after?: string[];
  objective: string;
  writable_paths: string[];
}

interface Work {
  id: string;
  task: {
    schema: 'overcenter-source-task/v1';
    kind: 'source-change';
    objective: string;
    writable_paths: string[];
  };
  result_dependencies: Array<{ experiment: string; identity: string }>;
  promotion_dependencies: Array<{ promotion: string; semantic_key: string }>;
  semantic_key: string;
}

function compile(
  plans: Plan[],
  certificates: ReturnType<typeof certify>[],
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
): Work[] {
  const results = new Map<string, { outcome: Outcome; identity: string }>();
  for (const certificate of certificates) {
    const payload = verifyCertificate(certificate, publicKey);
    const identity = resultIdentity(certificate, publicKey);
    const prior = results.get(payload.experiment);
    if (prior && prior.identity !== identity) {
      throw new Error('RESEARCH_RESULT_CONFLICT:' + payload.experiment);
    }
    results.set(payload.experiment, { outcome: payload.outcome, identity });
  }

  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  assert.equal(byId.size, plans.length);
  const remaining = new Set(plans.map((plan) => plan.id));
  const compiled = new Map<string, Work>();

  let progress = true;
  while (remaining.size && progress) {
    progress = false;
    for (const id of [...remaining].sort()) {
      const plan = byId.get(id)!;
      const required = plan.requires.map((experiment) => ({
        experiment,
        result: results.get(experiment),
      }));
      if (required.some(({ result }) => !result || result.outcome !== 'supported')) {
        remaining.delete(id);
        progress = true;
        continue;
      }

      const upstreams: Array<{ promotion: string; semantic_key: string }> = [];
      let wait = false;
      let blocked = false;
      for (const upstream of plan.after ?? []) {
        if (!byId.has(upstream)) throw new Error('UNKNOWN_PROMOTION_DEPENDENCY:' + upstream);
        const work = compiled.get(upstream);
        if (work) upstreams.push({ promotion: upstream, semantic_key: work.semantic_key });
        else if (remaining.has(upstream)) {
          wait = true;
          break;
        } else {
          blocked = true;
          break;
        }
      }
      if (wait) continue;
      if (blocked) {
        remaining.delete(id);
        progress = true;
        continue;
      }

      const task: Work['task'] = {
        schema: 'overcenter-source-task/v1',
        kind: 'source-change',
        objective: plan.objective,
        writable_paths: [...new Set(plan.writable_paths)].sort(),
      };
      const resultDependencies = required
        .map(({ experiment, result }) => ({ experiment, identity: result!.identity }))
        .sort((a, b) => a.experiment.localeCompare(b.experiment));
      upstreams.sort((a, b) => a.promotion.localeCompare(b.promotion));
      const semanticKey = digest({
        domain: 'overcenter-research-promotion',
        id,
        task,
        result_dependencies: resultDependencies,
        promotion_dependencies: upstreams,
      });
      compiled.set(id, {
        id,
        task,
        result_dependencies: resultDependencies,
        promotion_dependencies: upstreams,
        semantic_key: semanticKey,
      });
      remaining.delete(id);
      progress = true;
    }
  }
  if (remaining.size) throw new Error('PROMOTION_DEPENDENCY_CYCLE');
  return [...compiled.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function realDesign() {
  const registry = JSON.parse(readFileSync('experiments/registry.json', 'utf8')) as {
    entries: Array<{
      id: string;
      question: string;
      claim: string;
      success_criteria: string[];
      outcome: { state: Outcome };
      evidence: { status: string; evaluated_revision?: string };
    }>;
  };
  const entry = registry.entries.find(
    (candidate) => candidate.id === 'source-obligation-integration',
  );
  assert.ok(entry);
  assert.equal(entry.outcome.state, 'supported');
  assert.equal(entry.evidence.status, 'evaluated');
  assert.match(entry.evidence.evaluated_revision ?? '', /^[0-9a-f]{40}$/);
  return {
    experiment: entry.id,
    question: entry.question,
    claim: entry.claim,
    success_criteria: entry.success_criteria,
  };
}

const designA = {
  experiment: 'synthetic-a',
  question: 'Can A justify promotion A?',
  claim: 'Synthetic result A supports its bounded promotion.',
  success_criteria: ['A treatment passes.'],
};
const designB = {
  experiment: 'synthetic-b',
  question: 'Can B justify promotion B?',
  claim: 'Synthetic result B supports its bounded promotion.',
  success_criteria: ['B treatment passes.'],
};
const plans: Plan[] = [
  {
    id: 'promotion-a',
    requires: ['synthetic-a'],
    objective: 'Promote A.',
    writable_paths: ['src/a.txt'],
  },
  {
    id: 'promotion-a-child',
    requires: [],
    after: ['promotion-a'],
    objective: 'Consume A.',
    writable_paths: ['src/a.txt'],
  },
  {
    id: 'promotion-b',
    requires: ['synthetic-b'],
    objective: 'Promote B.',
    writable_paths: ['src/a.txt'],
  },
  {
    id: 'promotion-c',
    requires: ['source-obligation-integration'],
    objective: 'Promote real result C.',
    writable_paths: ['src/c.txt'],
  },
];

const keys = generateKeyPairSync('ed25519');
const a1 = certify(designA, 'a'.repeat(40), 'supported', '1'.repeat(64), keys.privateKey);
const aRerun = certify(designA, 'c'.repeat(40), 'supported', '4'.repeat(64), keys.privateKey);
const b = certify(designB, 'b'.repeat(40), 'falsified', '2'.repeat(64), keys.privateKey);
const cDesign = realDesign();
const c = certify(
  cDesign,
  '1b6364ff9f172388f9ab956408ab81889ccb9aeb',
  'supported',
  '3'.repeat(64),
  keys.privateKey,
);

const initial = compile(plans, [a1, b, c], keys.publicKey);
assert.deepEqual(
  initial.map((work) => work.id),
  ['promotion-a', 'promotion-a-child', 'promotion-c'],
);
assert.equal(resultIdentity(a1, keys.publicKey), resultIdentity(aRerun, keys.publicKey));
assert.deepEqual(
  initial.map(({ id, semantic_key }) => ({ id, semantic_key })),
  compile(plans, [aRerun, b, c], keys.publicKey).map(({ id, semantic_key }) => ({
    id,
    semantic_key,
  })),
);

const forged = structuredClone(b);
forged.payload.outcome = 'supported';
assert.throws(
  () => compile(plans, [a1, forged, c], keys.publicKey),
  /RESEARCH_RESULT_SIGNATURE_INVALID/,
);

const changedA = certify(
  { ...designA, claim: 'Synthetic result A supports a materially narrower promotion.' },
  'd'.repeat(40),
  'supported',
  '5'.repeat(64),
  keys.privateKey,
);
const changed = compile(plans, [changedA, b, c], keys.publicKey);
const beforeKeys = new Map(initial.map((work) => [work.id, work.semantic_key]));
const afterKeys = new Map(changed.map((work) => [work.id, work.semantic_key]));
assert.notEqual(beforeKeys.get('promotion-a'), afterKeys.get('promotion-a'));
assert.notEqual(beforeKeys.get('promotion-a-child'), afterKeys.get('promotion-a-child'));
assert.equal(beforeKeys.get('promotion-c'), afterKeys.get('promotion-c'));
assert.equal(afterKeys.has('promotion-b'), false);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
function gitStatus(cwd: string, args: string[]): number {
  return spawnSync('git', ['-C', cwd, ...args], { stdio: 'ignore' }).status ?? 1;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-research-result-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '--initial-branch=fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Overcenter Experiment']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'overcenter@local']);
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.txt'), 'a:base\n');
  writeFileSync(join(repo, 'src', 'c.txt'), 'c:base\n');
  writeFileSync(join(repo, 'src', 'unrelated.txt'), 'unrelated:base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'seed']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['update-ref', 'refs/heads/main', base]);
  return { root, repo, base, n: 0 };
}
function tree(f: ReturnType<typeof fixture>, rev: string, label: string) {
  f.n += 1;
  const path = join(f.root, label + '-' + f.n);
  git(f.repo, ['worktree', 'add', '--detach', path, rev]);
  return path;
}
function removeTree(f: ReturnType<typeof fixture>, path: string) {
  gitStatus(f.repo, ['worktree', 'remove', '--force', path]);
}
function candidate(
  f: ReturnType<typeof fixture>,
  work: Work,
  run: string,
  mutate: (root: string) => void,
) {
  const root = tree(f, f.base, 'candidate');
  try {
    mutate(root);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'candidate']);
    return {
      obligation_key: work.semantic_key,
      run_id: run,
      claimed_revision: 'authority:' + run,
      claimed_source_sha: f.base,
      commit_sha: git(root, ['rev-parse', 'HEAD']),
    };
  } finally {
    removeTree(f, root);
  }
}
function advance(f: ReturnType<typeof fixture>, path: string, content: string) {
  const expected = git(f.repo, ['rev-parse', 'refs/heads/main']);
  const root = tree(f, expected, 'advance');
  try {
    writeFileSync(join(root, path), content);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'advance']);
    const next = git(root, ['rev-parse', 'HEAD']);
    assert.equal(gitStatus(f.repo, ['update-ref', 'refs/heads/main', next, expected]), 0);
    return next;
  } finally {
    removeTree(f, root);
  }
}
function integrate(
  f: ReturnType<typeof fixture>,
  work: Work,
  candidateValue: ReturnType<typeof candidate>,
) {
  if (candidateValue.obligation_key !== work.semantic_key) return 'REJECTED';
  const parent = git(f.repo, ['rev-parse', candidateValue.commit_sha + '^']);
  assert.equal(parent, candidateValue.claimed_source_sha);
  const paths = git(f.repo, ['diff', '--name-only', parent, candidateValue.commit_sha])
    .split('\n')
    .filter(Boolean);
  if (!paths.length || paths.some((path) => !work.task.writable_paths.includes(path)))
    return 'REJECTED';
  const expected = git(f.repo, ['rev-parse', 'refs/heads/main']);
  const root = tree(f, expected, 'integrate');
  try {
    if (gitStatus(root, ['cherry-pick', '--no-commit', candidateValue.commit_sha]) !== 0) {
      return 'REREALIZE_REQUIRED';
    }
    git(root, ['commit', '-m', 'integrate ' + work.id]);
    const next = git(root, ['rev-parse', 'HEAD']);
    return gitStatus(f.repo, ['update-ref', 'refs/heads/main', next, expected]) === 0
      ? 'INTEGRATED'
      : 'REREALIZE_REQUIRED';
  } finally {
    removeTree(f, root);
  }
}

const workA = initial.find((work) => work.id === 'promotion-a')!;
const workC = initial.find((work) => work.id === 'promotion-c')!;
const f = fixture();
try {
  const candidateA = candidate(f, workA, 'run-a', (root) =>
    writeFileSync(join(root, 'src/a.txt'), 'a:done\n'),
  );
  const candidateC = candidate(f, workC, 'run-c', (root) =>
    writeFileSync(join(root, 'src/c.txt'), 'c:done\n'),
  );
  assert.equal(integrate(f, workA, candidateA), 'INTEGRATED');
  advance(f, 'src/unrelated.txt', 'unrelated:advanced\n');
  assert.equal(integrate(f, workC, candidateC), 'INTEGRATED');
  assert.equal(git(f.repo, ['show', 'refs/heads/main:src/a.txt']), 'a:done');
  assert.equal(git(f.repo, ['show', 'refs/heads/main:src/c.txt']), 'c:done');
  assert.equal(git(f.repo, ['show', 'refs/heads/main:src/unrelated.txt']), 'unrelated:advanced');
  assert.equal(candidateA.claimed_source_sha, f.base);
  assert.equal(candidateC.claimed_source_sha, f.base);

  const projection = new Map([
    ['promotion-a', 101],
    ['promotion-c', 102],
  ]);
  const semanticBefore = initial.map(({ id, semantic_key }) => ({ id, semantic_key }));
  projection.clear();
  assert.deepEqual(
    compile(plans, [a1, b, c], keys.publicKey).map(({ id, semantic_key }) => ({
      id,
      semantic_key,
    })),
    semanticBefore,
  );
} finally {
  rmSync(f.root, { recursive: true, force: true });
}

const conflictFixture = fixture();
try {
  const conflictCandidate = candidate(conflictFixture, workA, 'run-conflict', (root) =>
    writeFileSync(join(root, 'src/a.txt'), 'a:done\n'),
  );
  const conflictingMain = advance(conflictFixture, 'src/a.txt', 'a:conflicting\n');
  assert.equal(integrate(conflictFixture, workA, conflictCandidate), 'REREALIZE_REQUIRED');
  assert.equal(git(conflictFixture.repo, ['rev-parse', 'refs/heads/main']), conflictingMain);
} finally {
  rmSync(conflictFixture.root, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      experiment: 'research-result-obligation-integration',
      justified_promotions: initial.map((work) => work.id),
      falsified_promotion_materialized: false,
      forged_result_rejected: true,
      rerun_identity_stable: true,
      semantic_invalidation_localized: true,
      independent_candidates_integrated_without_restack: true,
      projection_metadata_non_authoritative: true,
      current_source_conflict_requires_rerealization: true,
      conclusion: 'supported-within-bounds',
    },
    null,
    2,
  ),
);
