import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';

export const SOURCE_TASK_SCHEMA = 'overcenter-source-task/v1' as const;
export const SOURCE_ASSIGNMENT_SCHEMA = 'overcenter-source-assignment/v1' as const;
export const SOURCE_CANDIDATE_SCHEMA = 'overcenter-source-candidate/v1' as const;

export interface SourceTaskPacket extends Record<string, unknown> {
  schema: typeof SOURCE_TASK_SCHEMA;
  kind: 'source-change';
  objective: string;
  writable_paths: string[];
}

export interface SourceClaimBinding {
  obligation_key: string;
  run_id: string;
  claimed_revision: string;
  source_sha: string;
}

export interface SourceAssignment {
  schema: typeof SOURCE_ASSIGNMENT_SCHEMA;
  obligation_id: string;
  task: SourceTaskPacket;
  claim: SourceClaimBinding;
}

export interface SourceCandidate {
  schema: typeof SOURCE_CANDIDATE_SCHEMA;
  obligation_key: string;
  run_id: string;
  claimed_revision: string;
  claimed_source_sha: string;
  commit_sha: string;
}

function validRepositoryPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return false;
  }
  return value
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git');
}

function exactSha(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(error);
}

export function validateSourceTaskPacket(value: unknown): SourceTaskPacket {
  if (!isData(value)) throw new Error('SOURCE_TASK_INVALID');
  assertExactKeys(
    value,
    ['schema', 'kind', 'objective', 'writable_paths'],
    [],
    'SOURCE_TASK_INVALID',
  );
  if (value.schema !== SOURCE_TASK_SCHEMA) throw new Error('SOURCE_TASK_SCHEMA_MISMATCH');
  if (value.kind !== 'source-change') throw new Error('SOURCE_TASK_KIND_INVALID');
  assertNonEmptyString(value.objective, 'SOURCE_TASK_OBJECTIVE_INVALID');

  if (!Array.isArray(value.writable_paths) || value.writable_paths.length === 0) {
    throw new Error('SOURCE_TASK_WRITABLE_PATHS_INVALID');
  }
  if (!value.writable_paths.every(validRepositoryPath)) {
    throw new Error('SOURCE_TASK_WRITABLE_PATH_INVALID');
  }
  if (new Set(value.writable_paths).size !== value.writable_paths.length) {
    throw new Error('SOURCE_TASK_WRITABLE_PATH_DUPLICATE');
  }

  return {
    schema: SOURCE_TASK_SCHEMA,
    kind: 'source-change',
    objective: value.objective,
    writable_paths: [...value.writable_paths].sort(),
  };
}

export function bindSourceClaim(
  obligationKey: string,
  runId: string,
  claimedRevision: string,
  sourceSha: string,
): SourceClaimBinding {
  assertNonEmptyString(obligationKey, 'SOURCE_CLAIM_OBLIGATION_KEY_INVALID');
  assertNonEmptyString(runId, 'SOURCE_CLAIM_RUN_ID_INVALID');
  assertNonEmptyString(claimedRevision, 'SOURCE_CLAIM_REVISION_INVALID');
  exactSha(sourceSha, 'SOURCE_CLAIM_SOURCE_SHA_INVALID');
  return {
    obligation_key: obligationKey,
    run_id: runId,
    claimed_revision: claimedRevision,
    source_sha: sourceSha,
  };
}

export function buildSourceAssignment(
  obligationId: string,
  task: unknown,
  claim: SourceClaimBinding,
): SourceAssignment {
  assertNonEmptyString(obligationId, 'SOURCE_ASSIGNMENT_OBLIGATION_INVALID');
  return {
    schema: SOURCE_ASSIGNMENT_SCHEMA,
    obligation_id: obligationId,
    task: validateSourceTaskPacket(task),
    claim: bindSourceClaim(
      claim.obligation_key,
      claim.run_id,
      claim.claimed_revision,
      claim.source_sha,
    ),
  };
}

export function validateSourceAssignment(value: unknown): SourceAssignment {
  if (!isData(value)) throw new Error('SOURCE_ASSIGNMENT_INVALID');
  assertExactKeys(
    value,
    ['schema', 'obligation_id', 'task', 'claim'],
    [],
    'SOURCE_ASSIGNMENT_INVALID',
  );
  if (value.schema !== SOURCE_ASSIGNMENT_SCHEMA) {
    throw new Error('SOURCE_ASSIGNMENT_SCHEMA_MISMATCH');
  }
  assertNonEmptyString(value.obligation_id, 'SOURCE_ASSIGNMENT_OBLIGATION_INVALID');
  if (!isData(value.claim)) throw new Error('SOURCE_ASSIGNMENT_CLAIM_INVALID');
  assertExactKeys(
    value.claim,
    ['obligation_key', 'run_id', 'claimed_revision', 'source_sha'],
    [],
    'SOURCE_ASSIGNMENT_CLAIM_INVALID',
  );
  return buildSourceAssignment(
    value.obligation_id,
    value.task,
    bindSourceClaim(
      value.claim.obligation_key,
      value.claim.run_id,
      value.claim.claimed_revision,
      value.claim.source_sha,
    ),
  );
}

export function validateSourceCandidate(
  value: unknown,
  claim: SourceClaimBinding,
): SourceCandidate {
  if (!isData(value)) throw new Error('SOURCE_CANDIDATE_INVALID');
  assertExactKeys(
    value,
    ['schema', 'obligation_key', 'run_id', 'claimed_revision', 'claimed_source_sha', 'commit_sha'],
    [],
    'SOURCE_CANDIDATE_INVALID',
  );
  if (value.schema !== SOURCE_CANDIDATE_SCHEMA) {
    throw new Error('SOURCE_CANDIDATE_SCHEMA_MISMATCH');
  }
  if (value.obligation_key !== claim.obligation_key) {
    throw new Error('SOURCE_CANDIDATE_OBLIGATION_MISMATCH');
  }
  if (value.run_id !== claim.run_id) throw new Error('SOURCE_CANDIDATE_RUN_MISMATCH');
  if (value.claimed_revision !== claim.claimed_revision) {
    throw new Error('SOURCE_CANDIDATE_REVISION_MISMATCH');
  }
  if (value.claimed_source_sha !== claim.source_sha) {
    throw new Error('SOURCE_CANDIDATE_SOURCE_MISMATCH');
  }
  exactSha(value.commit_sha, 'SOURCE_CANDIDATE_COMMIT_SHA_INVALID');

  return {
    schema: SOURCE_CANDIDATE_SCHEMA,
    obligation_key: value.obligation_key,
    run_id: value.run_id,
    claimed_revision: value.claimed_revision,
    claimed_source_sha: value.claimed_source_sha,
    commit_sha: value.commit_sha,
  };
}
