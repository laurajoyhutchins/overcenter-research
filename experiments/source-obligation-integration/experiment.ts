import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface SourceIntent {
  id: string;
  objective: string;
  writable_paths: string[];
  acceptance: Array<{ verifier: 'file-content-equals'; path: string; content: string }>;
}

interface SourceClaim {
  obligation_key: string;
  base_sha: string;
}

interface SourceCandidate {
  schema: 'overcenter-source-candidate/v1';
  obligation_key: string;
  claimed_base_sha: string;
  commit_sha: string;
}

type IntegrationResult =
  | { state: 'INTEGRATED'; commit_sha: string; attempts: number }
  | { state: 'ALREADY_INTEGRATED'; commit_sha: string; attempts: 0 }
  | {
      state: 'REJECTED' | 'REREALIZE_REQUIRED';
      reason: string;
      attempts: number;
    };

interface Fixture {
  root: string;
  repo: string;
  base_sha: string;
  sequence: number;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function gitStatus(cwd: string, args: string[]): number {
  return spawnSync('git', ['-C', cwd, ...args], { stdio: 'ignore' }).status ?? 1;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableSourceIntent(intent: SourceIntent): SourceIntent {
  return {
    id: intent.id,
    objective: intent.objective,
    writable_paths: [...intent.writable_paths].sort(),
    acceptance: [...intent.acceptance]
      .map((check) => ({ ...check }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function sourceObligationKey(intent: SourceIntent): string {
  return sha256(JSON.stringify(stableSourceIntent(intent)));
}

function claimSourceIntent(intent: SourceIntent, baseSha: string): SourceClaim {
  assert.match(baseSha, /^[0-9a-f]{40}$/);
  return { obligation_key: sourceObligationKey(intent), base_sha: baseSha };
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-source-integration-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '--initial-branch=fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Overcenter Experiment'], {
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'overcenter@local'], {
    stdio: 'ignore',
  });
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'feature.txt'), 'feature:base\n');
  writeFileSync(join(repo, 'src', 'unrelated.txt'), 'unrelated:base\n');
  writeFileSync(join(repo, 'src', 'policy.txt'), 'policy:allow\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'seed source']);
  const base_sha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['update-ref', 'refs/heads/main', base_sha]);
  return { root, repo, base_sha, sequence: 0 };
}

function worktree(f: Fixture, revision: string, label: string): string {
  f.sequence += 1;
  const path = join(f.root, `${label}-${f.sequence}`);
  git(f.repo, ['worktree', 'add', '--detach', path, revision]);
  return path;
}

function removeWorktree(f: Fixture, path: string): void {
  gitStatus(f.repo, ['worktree', 'remove', '--force', path]);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function commitCandidate(
  f: Fixture,
  claim: SourceClaim,
  mutate: (root: string) => void,
): SourceCandidate {
  const root = worktree(f, claim.base_sha, 'candidate');
  try {
    mutate(root);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'candidate source change']);
    const commit_sha = git(root, ['rev-parse', 'HEAD']);
    return {
      schema: 'overcenter-source-candidate/v1',
      obligation_key: claim.obligation_key,
      claimed_base_sha: claim.base_sha,
      commit_sha,
    };
  } finally {
    removeWorktree(f, root);
  }
}

function advanceMain(f: Fixture, mutate: (root: string) => void, message: string): string {
  const expected = git(f.repo, ['rev-parse', 'refs/heads/main']);
  const root = worktree(f, expected, 'main-advance');
  try {
    mutate(root);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', message]);
    const next = git(root, ['rev-parse', 'HEAD']);
    assert.equal(gitStatus(f.repo, ['update-ref', 'refs/heads/main', next, expected]), 0);
    return next;
  } finally {
    removeWorktree(f, root);
  }
}

function integratedCommit(
  f: Fixture,
  intent: SourceIntent,
  candidate: SourceCandidate,
): string | null {
  const commits = git(f.repo, ['log', 'refs/heads/main', '--format=%H']);
  if (!commits) return null;

  for (const commit of commits.split('\n')) {
    const body = git(f.repo, ['show', '-s', '--format=%B', commit]);
    if (!body.includes(`Overcenter-Candidate: ${candidate.commit_sha}`)) continue;
    if (!body.includes(`Overcenter-Obligation-Key: ${candidate.obligation_key}`)) continue;

    const parents = git(f.repo, ['show', '-s', '--format=%P', commit])
      .split(/\s+/)
      .filter(Boolean);
    if (parents.length !== 1) continue;

    const root = worktree(f, parents[0]!, 'replay-proof');
    try {
      if (gitStatus(root, ['cherry-pick', '--no-commit', candidate.commit_sha]) !== 0) continue;
      const reconstructedTree = git(root, ['write-tree']);
      const recordedTree = git(f.repo, ['show', '-s', '--format=%T', commit]);
      if (reconstructedTree !== recordedTree) continue;
      if (!acceptanceSatisfied(root, intent)) continue;

      const current = worktree(f, 'refs/heads/main', 'replay-current');
      try {
        if (!acceptanceSatisfied(current, intent)) continue;
      } finally {
        removeWorktree(f, current);
      }
      return commit;
    } finally {
      removeWorktree(f, root);
    }
  }
  return null;
}

function changedPaths(f: Fixture, candidate: SourceCandidate): string[] {
  const parent = git(f.repo, ['rev-parse', `${candidate.commit_sha}^`]);
  if (parent !== candidate.claimed_base_sha) {
    throw new Error('CANDIDATE_PARENT_MISMATCH');
  }
  const output = git(f.repo, [
    'diff',
    '--name-only',
    candidate.claimed_base_sha,
    candidate.commit_sha,
    '--',
  ]);
  return output ? output.split('\n').sort() : [];
}

function acceptanceSatisfied(root: string, intent: SourceIntent): boolean {
  return intent.acceptance.every((check) => {
    try {
      return readFileSync(join(root, check.path), 'utf8') === check.content;
    } catch {
      return false;
    }
  });
}

function integrateCandidate(
  f: Fixture,
  intent: SourceIntent,
  candidate: SourceCandidate,
  options: { beforeCas?: (attempt: number) => void; maxAttempts?: number } = {},
): IntegrationResult {
  if (candidate.obligation_key !== sourceObligationKey(intent)) {
    return { state: 'REJECTED', reason: 'OBLIGATION_KEY_MISMATCH', attempts: 0 };
  }

  let paths: string[];
  try {
    paths = changedPaths(f, candidate);
  } catch (error: unknown) {
    return {
      state: 'REJECTED',
      reason: error instanceof Error ? error.message : String(error),
      attempts: 0,
    };
  }
  if (paths.length === 0 || paths.some((path) => !intent.writable_paths.includes(path))) {
    return { state: 'REJECTED', reason: 'SOURCE_SCOPE_VIOLATION', attempts: 0 };
  }

  const replay = integratedCommit(f, intent, candidate);
  if (replay) return { state: 'ALREADY_INTEGRATED', commit_sha: replay, attempts: 0 };

  const maxAttempts = options.maxAttempts ?? 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const expectedMain = git(f.repo, ['rev-parse', 'refs/heads/main']);
    const root = worktree(f, expectedMain, 'integration');
    try {
      const applied = gitStatus(root, ['cherry-pick', '--no-commit', candidate.commit_sha]);
      if (applied !== 0) {
        return { state: 'REREALIZE_REQUIRED', reason: 'SOURCE_APPLY_CONFLICT', attempts: attempt };
      }
      if (!acceptanceSatisfied(root, intent)) {
        return {
          state: 'REREALIZE_REQUIRED',
          reason: 'SOURCE_ACCEPTANCE_FAILED',
          attempts: attempt,
        };
      }

      git(root, [
        'commit',
        '-m',
        `integrate ${intent.id}\n\nOvercenter-Obligation-Key: ${candidate.obligation_key}\nOvercenter-Candidate: ${candidate.commit_sha}`,
      ]);
      const integrated = git(root, ['rev-parse', 'HEAD']);
      options.beforeCas?.(attempt);
      if (gitStatus(f.repo, ['update-ref', 'refs/heads/main', integrated, expectedMain]) === 0) {
        return { state: 'INTEGRATED', commit_sha: integrated, attempts: attempt };
      }
    } finally {
      removeWorktree(f, root);
    }
  }
  return {
    state: 'REREALIZE_REQUIRED',
    reason: 'SOURCE_INTEGRATION_CAS_EXHAUSTED',
    attempts: maxAttempts,
  };
}

function show(f: Fixture, path: string): string {
  return git(f.repo, ['show', `refs/heads/main:${path}`]);
}

const intent: SourceIntent = {
  id: 'seal-effect-authority',
  objective: 'Make provider mutation reachable only through current EffectAuthority.',
  writable_paths: ['src/feature.txt'],
  acceptance: [
    { verifier: 'file-content-equals', path: 'src/feature.txt', content: 'feature:sealed\n' },
    { verifier: 'file-content-equals', path: 'src/policy.txt', content: 'policy:allow\n' },
  ],
};

const identity = (() => {
  const f = fixture();
  try {
    const first = claimSourceIntent(intent, f.base_sha);
    const later = advanceMain(
      f,
      (root) => write(join(root, 'src', 'unrelated.txt'), 'unrelated:later\n'),
      'advance unrelated source',
    );
    const second = claimSourceIntent(intent, later);
    assert.equal(first.obligation_key, second.obligation_key);
    assert.notEqual(first.base_sha, second.base_sha);
    return { stable_key: first.obligation_key, distinct_claim_bases: true };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
})();

const unrelatedAdvance = (() => {
  const f = fixture();
  try {
    const claim = claimSourceIntent(intent, f.base_sha);
    const candidate = commitCandidate(f, claim, (root) => {
      write(join(root, 'src', 'feature.txt'), 'feature:sealed\n');
    });
    const advanced = advanceMain(
      f,
      (root) => write(join(root, 'src', 'unrelated.txt'), 'unrelated:advanced\n'),
      'independent main change',
    );
    const result = integrateCandidate(f, intent, candidate);
    assert.equal(result.state, 'INTEGRATED');
    assert.equal(show(f, 'src/feature.txt'), 'feature:sealed');
    assert.equal(show(f, 'src/unrelated.txt'), 'unrelated:advanced');
    assert.equal(git(f.repo, ['rev-parse', `${result.commit_sha}^`]), advanced);
    return { state: result.state, rebased_over_unrelated_main: true };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
})();

const scopeViolation = (() => {
  const f = fixture();
  try {
    const claim = claimSourceIntent(intent, f.base_sha);
    const candidate = commitCandidate(f, claim, (root) => {
      write(join(root, 'src', 'feature.txt'), 'feature:sealed\n');
      write(join(root, 'src', 'unrelated.txt'), 'unrelated:worker-touched\n');
    });
    const before = git(f.repo, ['rev-parse', 'refs/heads/main']);
    const result = integrateCandidate(f, intent, candidate);
    assert.deepEqual(result, {
      state: 'REJECTED',
      reason: 'SOURCE_SCOPE_VIOLATION',
      attempts: 0,
    });
    assert.equal(git(f.repo, ['rev-parse', 'refs/heads/main']), before);
    return { state: result.state, reason: result.reason };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
})();

const conflict = (() => {
  const f = fixture();
  try {
    const claim = claimSourceIntent(intent, f.base_sha);
    const candidate = commitCandidate(f, claim, (root) => {
      write(join(root, 'src', 'feature.txt'), 'feature:sealed\n');
    });
    const advanced = advanceMain(
      f,
      (root) => write(join(root, 'src', 'feature.txt'), 'feature:other-change\n'),
      'conflicting main change',
    );
    const result = integrateCandidate(f, intent, candidate);
    assert.deepEqual(result, {
      state: 'REREALIZE_REQUIRED',
      reason: 'SOURCE_APPLY_CONFLICT',
      attempts: 1,
    });
    assert.equal(git(f.repo, ['rev-parse', 'refs/heads/main']), advanced);
    return { state: result.state, reason: result.reason };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
})();

const acceptanceDrift = (() => {
  const f = fixture();
  try {
    const claim = claimSourceIntent(intent, f.base_sha);
    const candidate = commitCandidate(f, claim, (root) => {
      write(join(root, 'src', 'feature.txt'), 'feature:sealed\n');
    });
    const advanced = advanceMain(
      f,
      (root) => write(join(root, 'src', 'policy.txt'), 'policy:deny\n'),
      'change acceptance context',
    );
    const result = integrateCandidate(f, intent, candidate);
    assert.deepEqual(result, {
      state: 'REREALIZE_REQUIRED',
      reason: 'SOURCE_ACCEPTANCE_FAILED',
      attempts: 1,
    });
    assert.equal(git(f.repo, ['rev-parse', 'refs/heads/main']), advanced);
    return { state: result.state, reason: result.reason };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
})();

const forgedReplayMarker = (() => {
  const f = fixture();
  try {
    const claim = claimSourceIntent(intent, f.base_sha);
    const candidate = commitCandidate(f, claim, (root) => {
      write(join(root, 'src', 'feature.txt'), 'feature:sealed\n');
    });
    const forged = advanceMain(
      f,
      (root) => write(join(root, 'src', 'unrelated.txt'), 'unrelated:forged-marker\n'),
      `unrelated change\n\nOvercenter-Obligation-Key: ${candidate.obligation_key}\nOvercenter-Candidate: ${candidate.commit_sha}`,
    );

    const result = integrateCandidate(f, intent, candidate);
    assert.equal(result.state, 'INTEGRATED');
    assert.notEqual(result.commit_sha, forged);
    assert.equal(git(f.repo, ['rev-parse', `${result.commit_sha}^`]), forged);
    assert.equal(show(f, 'src/feature.txt'), 'feature:sealed');
    assert.equal(show(f, 'src/unrelated.txt'), 'unrelated:forged-marker');
    return {
      forged_marker_rejected_as_replay: true,
      state: result.state,
    };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
})();

const casRaceAndReplay = (() => {
  const f = fixture();
  try {
    const claim = claimSourceIntent(intent, f.base_sha);
    const candidate = commitCandidate(f, claim, (root) => {
      write(join(root, 'src', 'feature.txt'), 'feature:sealed\n');
    });
    let injected = false;
    const result = integrateCandidate(f, intent, candidate, {
      beforeCas: (attempt) => {
        if (attempt !== 1 || injected) return;
        injected = true;
        advanceMain(
          f,
          (root) => write(join(root, 'src', 'unrelated.txt'), 'unrelated:cas-race\n'),
          'concurrent main advance',
        );
      },
    });
    assert.equal(result.state, 'INTEGRATED');
    assert.equal(result.attempts, 2);
    assert.equal(show(f, 'src/feature.txt'), 'feature:sealed');
    assert.equal(show(f, 'src/unrelated.txt'), 'unrelated:cas-race');

    const mainAfter = git(f.repo, ['rev-parse', 'refs/heads/main']);
    const replay = integrateCandidate(f, intent, candidate);
    assert.equal(replay.state, 'ALREADY_INTEGRATED');
    assert.equal(replay.commit_sha, mainAfter);
    assert.equal(git(f.repo, ['rev-parse', 'refs/heads/main']), mainAfter);
    return {
      first_state: result.state,
      attempts: result.attempts,
      replay_state: replay.state,
      concurrent_main_preserved: true,
    };
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
})();

console.log(
  JSON.stringify(
    {
      experiment: 'source-obligation-integration',
      stable_semantic_identity: identity,
      unrelated_main_advance: unrelatedAdvance,
      hostile_scope: scopeViolation,
      conflicting_main: conflict,
      acceptance_context_drift: acceptanceDrift,
      forged_replay_marker: forgedReplayMarker,
      cas_race_and_replay: casRaceAndReplay,
      conclusion: 'supported-within-bounds',
    },
    null,
    2,
  ),
);
