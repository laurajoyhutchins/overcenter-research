import type { SourceChangeIntegratedPostcondition, Work } from '../model.ts';
import { validPath } from './assignment-capsule.ts';
import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';

export const SOURCE_CHANGE_TASK_SCHEMA = 'overcenter-source-change-task/v1' as const;
export const SOURCE_CHANGE_ASSIGNMENT_SCHEMA = 'overcenter-source-change-assignment/v1' as const;

export interface SourceChangeTaskPacket extends Record<string, unknown> {
  schema: typeof SOURCE_CHANGE_TASK_SCHEMA;
  kind: 'source-change';
  objective: string;
  writable_paths: string[];
}

export interface SourceChangeAssignment {
  schema: typeof SOURCE_CHANGE_ASSIGNMENT_SCHEMA;
  source_sha: string;
  work: Work & {
    status: 'EXECUTING';
    run_id: string;
    claimed_revision: string;
    execution_generation: number;
    packet: SourceChangeTaskPacket;
    postcondition: SourceChangeIntegratedPostcondition;
  };
}

function fail(code: string): never {
  throw new Error(code);
}

function command(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === 'string' && part.length > 0 && !part.includes('\0'))
  );
}

export function validateSourceChangeTaskPacket(value: unknown): SourceChangeTaskPacket {
  if (!isData(value)) fail('SOURCE_CHANGE_TASK_INVALID');
  assertExactKeys(
    value,
    ['schema', 'kind', 'objective', 'writable_paths'],
    [],
    'SOURCE_CHANGE_TASK_INVALID',
  );
  if (value.schema !== SOURCE_CHANGE_TASK_SCHEMA) fail('SOURCE_CHANGE_TASK_SCHEMA_MISMATCH');
  if (value.kind !== 'source-change') fail('SOURCE_CHANGE_TASK_KIND_INVALID');
  assertNonEmptyString(value.objective, 'SOURCE_CHANGE_OBJECTIVE_INVALID');
  if (
    !Array.isArray(value.writable_paths) ||
    value.writable_paths.length === 0 ||
    !value.writable_paths.every(validPath)
  ) {
    fail('SOURCE_CHANGE_WRITABLE_PATHS_INVALID');
  }
  if (new Set(value.writable_paths).size !== value.writable_paths.length) {
    fail('SOURCE_CHANGE_WRITABLE_PATHS_DUPLICATE');
  }
  return structuredClone(value) as unknown as SourceChangeTaskPacket;
}

export function validateSourceChangePostcondition(
  value: unknown,
): SourceChangeIntegratedPostcondition {
  if (!isData(value)) fail('SOURCE_CHANGE_POSTCONDITION_INVALID');
  assertExactKeys(
    value,
    ['verifier', 'target_ref', 'acceptance_commands'],
    [],
    'SOURCE_CHANGE_POSTCONDITION_INVALID',
  );
  if (value.verifier !== 'source-change-integrated/v1') {
    fail('SOURCE_CHANGE_POSTCONDITION_VERIFIER_INVALID');
  }
  if (
    typeof value.target_ref !== 'string' ||
    !value.target_ref.startsWith('refs/heads/') ||
    /[\s\0]/.test(value.target_ref)
  ) {
    fail('SOURCE_CHANGE_TARGET_REF_INVALID');
  }
  if (
    !Array.isArray(value.acceptance_commands) ||
    value.acceptance_commands.length === 0 ||
    !value.acceptance_commands.every(command)
  ) {
    fail('SOURCE_CHANGE_ACCEPTANCE_COMMANDS_INVALID');
  }
  return structuredClone(value) as unknown as SourceChangeIntegratedPostcondition;
}

export function buildSourceChangeAssignment(work: Work, sourceSha: string): SourceChangeAssignment {
  const source = sourceSha.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(source)) fail('SOURCE_CHANGE_SOURCE_SHA_INVALID');
  if (work.status !== 'EXECUTING') fail('SOURCE_CHANGE_WORK_NOT_EXECUTING');
  if (!work.run_id) fail('SOURCE_CHANGE_RUN_ID_INVALID');
  if (!work.claimed_revision) fail('SOURCE_CHANGE_CLAIMED_REVISION_INVALID');
  if (!Number.isSafeInteger(work.execution_generation) || (work.execution_generation ?? 0) < 1) {
    fail('SOURCE_CHANGE_EXECUTION_GENERATION_INVALID');
  }

  const packet = validateSourceChangeTaskPacket(work.packet);
  const postcondition = validateSourceChangePostcondition(work.postcondition);
  return {
    schema: SOURCE_CHANGE_ASSIGNMENT_SCHEMA,
    source_sha: source,
    work: {
      ...structuredClone(work),
      status: 'EXECUTING',
      run_id: work.run_id,
      claimed_revision: work.claimed_revision,
      execution_generation: work.execution_generation!,
      packet,
      postcondition,
    },
  };
}

export function encodeSourceChangeAssignment(assignment: SourceChangeAssignment): Buffer {
  return Buffer.from(`${JSON.stringify(assignment, null, 2)}\n`, 'utf8');
}
