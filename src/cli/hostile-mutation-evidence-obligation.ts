import { execFileSync } from 'node:child_process';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
import {
  compileHostileMutationEvidenceObligation,
  HOSTILE_MUTATION_EVIDENCE_OBLIGATION_ID,
  HOSTILE_MUTATION_EVIDENCE_PATH,
} from '../evidence/hostile-mutation-obligation.ts';
import { observationVerified, observePostconditionAsync } from '../observation/observe.ts';
import { observeGithubHostileMutationEvidence } from '../providers/github/hostile-mutation-evidence.ts';
import { requiredEnv } from './project-command-runtime.ts';

const mode = process.argv[2];
if (mode !== 'reconcile' && mode !== 'settle') {
  throw new Error('usage: hostile-mutation-evidence-obligation.ts <reconcile|settle>');
}

const repo = process.cwd();
const repositoryId = Number(requiredEnv('GITHUB_REPOSITORY_ID'));
const repositoryFullName = requiredEnv('GITHUB_REPOSITORY');
const token = requiredEnv('GITHUB_TOKEN');
const authorityRef = process.env.OVERCENTER_PROJECT_AUTHORITY_REF ?? 'refs/overcenter/state';
const remote = process.env.OVERCENTER_PROJECT_REMOTE ?? 'origin';

if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
  throw new Error('GITHUB_REPOSITORY_ID_INVALID');
}

function sourceSha(): string {
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('HOSTILE_MUTATION_SOURCE_SHA_INVALID');
  return sha;
}

function obligation() {
  return compileHostileMutationEvidenceObligation({
    repo,
    sourceSha: sourceSha(),
    repositoryId,
    repositoryFullName,
  });
}

const kernel = new GitOvercenterKernel(repo, {
  ref: authorityRef,
  remote,
  githubToken: token,
  observationContext: {
    observeGithubHostileMutationEvidence: (postcondition) =>
      observeGithubHostileMutationEvidence(token, postcondition),
  },
});

if (!kernel.head()) throw new Error('HOSTILE_MUTATION_AUTHORITY_MISSING');

async function reconcile(waitForIdle: boolean) {
  for (let attempt = 0; attempt < (waitForIdle ? 90 : 16); attempt += 1) {
    const expected = kernel.head();
    if (!expected) throw new Error('HOSTILE_MUTATION_AUTHORITY_MISSING');
    try {
      return {
        state: 'reconciled' as const,
        result: kernel.reconcileGraph([obligation()], expected),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'STALE_REVISION') continue;
      if (message === 'PROJECT_BUSY' && waitForIdle) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      if (message === 'PROJECT_BUSY') return { state: 'deferred' as const, reason: message };
      throw error;
    }
  }
  throw new Error('HOSTILE_MUTATION_GRAPH_RECONCILIATION_EXHAUSTED');
}

if (mode === 'reconcile') {
  console.log(JSON.stringify(await reconcile(false), null, 2));
} else {
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'experiments/production-criticality-ranking/verify-mutation-evidence-sources.ts',
    ],
    {
      cwd: repo,
      stdio: 'inherit',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: repositoryFullName,
        GITHUB_TOKEN: token,
      },
    },
  );

  await reconcile(true);
  const desired = obligation();
  const observed = await observePostconditionAsync(desired.postcondition, {
    githubToken: token,
    observeGithubHostileMutationEvidence: (postcondition) =>
      observeGithubHostileMutationEvidence(token, postcondition),
  });
  if (!observationVerified(desired.postcondition, observed)) {
    throw new Error(
      `HOSTILE_MUTATION_EVIDENCE_POSTCONDITION_NOT_CURRENT:${observed.observation_error ?? observed.actual_state ?? 'unknown'}`,
    );
  }

  let completed = false;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const work = kernel
      .inspect()
      .find((candidate) => candidate.id === HOSTILE_MUTATION_EVIDENCE_OBLIGATION_ID);
    if (!work) throw new Error('HOSTILE_MUTATION_OBLIGATION_MISSING');
    if (work.status === 'DONE') {
      console.log(
        JSON.stringify(
          {
            state: 'already-done',
            obligation_id: work.id,
            authority_head: kernel.head(),
          },
          null,
          2,
        ),
      );
      completed = true;
      break;
    }
    if (work.status !== 'READY') {
      throw new Error(`HOSTILE_MUTATION_OBLIGATION_NOT_READY:${work.status}`);
    }

    try {
      const permit = kernel.claim(work.id, work.revision);
      const receipt = await kernel.resolveAsync(permit, {
        hostile_mutation_evidence: {
          verifier: 'verify-mutation-evidence-sources.ts',
        },
      });
      if (receipt.disposition !== 'DONE' || receipt.verified !== true) {
        throw new Error(`HOSTILE_MUTATION_OBLIGATION_NOT_SETTLED:${receipt.disposition}`);
      }
      console.log(
        JSON.stringify(
          {
            state: 'settled',
            obligation_id: work.id,
            run_id: receipt.run_id,
            settlement_commit: receipt.settlement_commit ?? null,
            authority_head: kernel.head(),
          },
          null,
          2,
        ),
      );
      completed = true;
      break;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'STALE_REVISION' || message === 'CLAIM_LOST') continue;
      throw error;
    }
  }
  if (!completed) throw new Error('HOSTILE_MUTATION_SETTLEMENT_CONTENTION_EXHAUSTED');
}
