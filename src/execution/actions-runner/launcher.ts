import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { sha256 } from '../../digest.ts';
import type { GithubActionsRunnerConnection } from '../../providers/github/actions-runner-backend.ts';
import { assertNoProviderCredentials, minimalExecutionEnvironment } from './environment.ts';

export interface GithubActionsRunnerLaunchResult {
  runner_id: number;
  runner_name: string;
  exit_code: 0;
}

export type GithubActionsRunnerSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

async function spawnRunner(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}

function runnerScript(root: string): string {
  const script = join(root, 'run.sh');
  if (!existsSync(script)) throw new Error('GITHUB_ACTIONS_RUNNER_SCRIPT_MISSING');
  const stat = lstatSync(script);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('GITHUB_ACTIONS_RUNNER_SCRIPT_INVALID');
  }
  return script;
}

function requireCleanWorkFolder(root: string): void {
  const work = join(root, '_work');
  if (!existsSync(work)) return;
  const stat = lstatSync(work);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('GITHUB_ACTIONS_RUNNER_WORK_FOLDER_INVALID');
  }
  if (readdirSync(work).length !== 0) {
    throw new Error('GITHUB_ACTIONS_RUNNER_WORK_FOLDER_NOT_CLEAN');
  }
}

export async function launchGithubActionsJitRunner(
  connection: GithubActionsRunnerConnection,
  {
    runnerRoot,
    spawnProcess = spawnRunner,
    processEnv = process.env,
    extraEnv = {},
  }: {
    runnerRoot: string;
    spawnProcess?: GithubActionsRunnerSpawn;
    processEnv?: NodeJS.ProcessEnv;
    extraEnv?: NodeJS.ProcessEnv;
  },
): Promise<GithubActionsRunnerLaunchResult> {
  if (!isAbsolute(runnerRoot)) {
    throw new Error('GITHUB_ACTIONS_RUNNER_ROOT_MUST_BE_ABSOLUTE');
  }
  const root = resolve(runnerRoot);
  const script = runnerScript(root);
  requireCleanWorkFolder(root);

  if (
    !connection.encoded_jit_config ||
    sha256(connection.encoded_jit_config) !== connection.encoded_jit_config_sha256
  ) {
    throw new Error('GITHUB_ACTIONS_RUNNER_JIT_CONFIG_DIGEST_MISMATCH');
  }

  const env = {
    ...minimalExecutionEnvironment(processEnv),
    ...extraEnv,
  };
  assertNoProviderCredentials(env, 'GITHUB_ACTIONS_RUNNER');

  const outcome = await spawnProcess(script, ['--jitconfig', connection.encoded_jit_config], {
    cwd: root,
    env,
  });
  if (outcome.code !== 0) {
    const detail = outcome.signal ?? outcome.code ?? 'unknown';
    throw new Error(`GITHUB_ACTIONS_RUNNER_EXIT_FAILED:${detail}`);
  }

  return {
    runner_id: connection.runner_id,
    runner_name: connection.runner_name,
    exit_code: 0,
  };
}
