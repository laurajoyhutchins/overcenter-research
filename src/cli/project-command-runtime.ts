import { appendFileSync } from 'node:fs';

import type { ProjectCommandContext } from '../authority/project-agent-protocol.ts';
import { isPositiveSafeInteger } from '../validation.ts';

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function positiveIntegerEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!isPositiveSafeInteger(value)) throw new Error(`${name}_INVALID`);
  return value;
}

export function commandOption(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name}_REQUIRES_VALUE`);
  return value;
}

export function projectCommandContext(): ProjectCommandContext {
  return {
    repository_id: positiveIntegerEnv('OVERCENTER_COMMAND_REPOSITORY_ID'),
    repository_full_name: requiredEnv('OVERCENTER_COMMAND_REPOSITORY'),
    command_source_sha: requiredEnv('OVERCENTER_COMMAND_SOURCE_SHA'),
    command_run_id: positiveIntegerEnv('OVERCENTER_COMMAND_RUN_ID'),
    command_run_attempt: positiveIntegerEnv('OVERCENTER_COMMAND_RUN_ATTEMPT'),
  };
}

export function appendGithubOutputs(values: Record<string, string | number | boolean>): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  for (const [key, value] of Object.entries(values)) {
    appendFileSync(output, `${key}=${String(value)}\n`);
  }
}
