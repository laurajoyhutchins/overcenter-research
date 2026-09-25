import { execFileSync } from 'node:child_process';

import { compileHostileMutationEvidenceFromRepository } from '../evidence/hostile-mutation-obligation.ts';
import {
  reconcileSystemEvidence,
  settleSystemEvidence,
} from '../evidence/system-evidence-lifecycle.ts';
import { observeGithubSourceBoundEvidence } from '../providers/github/source-bound-evidence.ts';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
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

const definition = {
  obligation: () =>
    compileHostileMutationEvidenceFromRepository({
      repo,
      sourceSha: sourceSha(),
      repositoryId,
      repositoryFullName,
    }),
};

const kernel = new GitOvercenterKernel(repo, {
  ref: authorityRef,
  remote,
  githubToken: token,
  observationContext: {
    observeGithubSourceBoundEvidence: (postcondition) =>
      observeGithubSourceBoundEvidence(token, postcondition),
  },
});
if (!kernel.head()) throw new Error('HOSTILE_MUTATION_AUTHORITY_MISSING');

if (mode === 'reconcile') {
  console.log(JSON.stringify(await reconcileSystemEvidence(kernel, definition), null, 2));
} else {
  const receipt = await settleSystemEvidence(kernel, definition, {
    verify: () => {
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
    },
    diagnostic: {
      hostile_mutation_evidence: {
        verifier: 'verify-mutation-evidence-sources.ts',
      },
    },
  });
  console.log(JSON.stringify(receipt, null, 2));
}
