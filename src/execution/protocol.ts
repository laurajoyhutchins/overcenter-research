import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';
import type { ExecutionPermit } from '../model.ts';

export const COMPUTATION_EXECUTION_SCHEMA='overcenter-computation-execution-v1' as const;
export const PROCESS_SPEC_SCHEMA='overcenter-process-spec-v1' as const;
export const COMPUTATION_EVIDENCE_SCHEMA='overcenter-computation-attempt-evidence-v1' as const;
export const EXECUTOR_COMMAND_SCHEMA='overcenter-executor-command-v1' as const;
export const EXECUTOR_HELLO_SCHEMA='overcenter-executor-hello-v1' as const;

const MAX_SPEC_BYTES=1024*1024;
const MAX_ARG_COUNT=256;
const MAX_ARG_BYTES=32*1024;
const MAX_ENV_COUNT=256;
const MAX_ENV_VALUE_BYTES=128*1024;
const MAX_TIMEOUT_MS=24*60*60*1000;
const MAX_CAPTURE_BYTES=16*1024*1024;

export interface ProcessSpecV1 {
  schema:typeof PROCESS_SPEC_SCHEMA;
  executable:string;
  argv:string[];
  cwd:string;
  env:Record<string,string>;
  timeout_ms:number;
  stdout_max_bytes:number;
  stderr_max_bytes:number;
}

export interface ComputationExecutionV1 {
  schema:typeof COMPUTATION_EXECUTION_SCHEMA;
  run_id:string;
  obligation_id:string;
  claimed_revision:string;
  execution_generation:number;
  execution_authority_commit:string;
  execution_capability:string;
  execution_capability_sha256:string;
  execution_spec_base64:string;
  execution_spec_sha256:string;
}

export interface ExecutionIdentityV1 {
  run_id:string;
  execution_generation:number;
  execution_authority_commit:string;
}

export interface ExecutorHelloV1 {
  schema:typeof EXECUTOR_HELLO_SCHEMA;
  execution_context_sha256:string;
  containment_id:string;
}

export type ExecutorCommandV1 =
  | {
      schema:typeof EXECUTOR_COMMAND_SCHEMA;
      kind:'execute';
      execution:ComputationExecutionV1;
    }
  | {
      schema:typeof EXECUTOR_COMMAND_SCHEMA;
      kind:'cancel';
      identity:ExecutionIdentityV1;
    };

export interface ComputationAttemptEvidenceV1 {
  schema:typeof COMPUTATION_EVIDENCE_SCHEMA;
  run_id:string;
  obligation_id:string;
  claimed_revision:string;
  execution_generation:number;
  execution_authority_commit:string;
  execution_capability_sha256:string;
  execution_spec_sha256:string;
  outcome:'completed'|'failed'|'cancelled';
  exit_code?:number;
  signal?:string;
  stdout_base64?:string;
  stdout_sha256:string;
  stdout_truncated:boolean;
  stderr_base64?:string;
  stderr_sha256:string;
  stderr_truncated:boolean;
  error?:string;
}

function sha256Hex(bytes:Uint8Array|string):string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Tagged(bytes:Uint8Array|string):string {
  return 'sha256:'+sha256Hex(bytes);
}

function assertPlainObject(value:unknown,name:string):asserts value is Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) {
    throw new Error(`${name.toUpperCase()}_INVALID`);
  }
}

function assertExactKeys(
  value:Record<string,unknown>,
  required:string[],
  optional:string[]=[],
  name='object',
):void {
  const allowed=new Set([...required,...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${name.toUpperCase()}_UNKNOWN_FIELD:${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`${name.toUpperCase()}_MISSING_FIELD:${key}`);
  }
}

function assertBoundedString(value:unknown,name:string,maxBytes=4096):asserts value is string {
  if (
    typeof value!=='string'
    || value.length===0
    || value.includes('\0')
    || Buffer.byteLength(value,'utf8')>maxBytes
  ) {
    throw new Error(`${name.toUpperCase()}_INVALID`);
  }
}

function assertSafeIntegerRange(value:unknown,name:string,min:number,max:number):asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number)<min || (value as number)>max) {
    throw new Error(`${name.toUpperCase()}_INVALID`);
  }
}

function assertSha256Hex(value:unknown,name:string):asserts value is string {
  if (typeof value!=='string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name.toUpperCase()}_INVALID`);
  }
}

function assertSha256Tagged(value:unknown,name:string):asserts value is string {
  if (typeof value!=='string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name.toUpperCase()}_INVALID`);
  }
}

export function validateExecutorHello(value:unknown):ExecutorHelloV1 {
  assertPlainObject(value,'executor_hello');
  assertExactKeys(value,[
    'schema',
    'execution_context_sha256',
    'containment_id',
  ],[],'executor_hello');
  if (value.schema!==EXECUTOR_HELLO_SCHEMA) {
    throw new Error('EXECUTOR_HELLO_SCHEMA_MISMATCH');
  }
  assertSha256Tagged(value.execution_context_sha256,'execution_context_sha256');
  assertBoundedString(value.containment_id,'containment_id',512);
  return {
    schema:EXECUTOR_HELLO_SCHEMA,
    execution_context_sha256:value.execution_context_sha256,
    containment_id:value.containment_id,
  };
}

function decodeCanonicalBase64(
  value:unknown,
  maxBytes=MAX_SPEC_BYTES,
  errorCode='EXECUTION_SPEC_BASE64_INVALID',
):Buffer {
  if (typeof value!=='string' || value.length===0) {
    throw new Error(errorCode);
  }
  const bytes=Buffer.from(value,'base64');
  if (bytes.length===0 || bytes.length>maxBytes || bytes.toString('base64')!==value) {
    throw new Error(errorCode);
  }
  return bytes;
}

export function validateProcessSpec(value:unknown):ProcessSpecV1 {
  assertPlainObject(value,'process_spec');
  assertExactKeys(value,[
    'schema',
    'executable',
    'argv',
    'cwd',
    'env',
    'timeout_ms',
    'stdout_max_bytes',
    'stderr_max_bytes',
  ],[],'process_spec');

  if (value.schema!==PROCESS_SPEC_SCHEMA) throw new Error('PROCESS_SPEC_SCHEMA_MISMATCH');
  assertBoundedString(value.executable,'executable',4096);
  if (!path.isAbsolute(value.executable)) throw new Error('EXECUTABLE_MUST_BE_ABSOLUTE');

  if (!Array.isArray(value.argv) || value.argv.length>MAX_ARG_COUNT) {
    throw new Error('ARGV_INVALID');
  }
  const argv=value.argv.map((arg,index)=>{
    if (typeof arg!=='string' || arg.includes('\0') || Buffer.byteLength(arg,'utf8')>MAX_ARG_BYTES) {
      throw new Error(`ARGV_INVALID:${index}`);
    }
    return arg;
  });

  assertBoundedString(value.cwd,'cwd',4096);
  if (path.isAbsolute(value.cwd)) throw new Error('CWD_MUST_BE_RELATIVE');
  const clean=path.normalize(value.cwd);
  if (clean==='..' || clean.startsWith('../')) throw new Error('CWD_ESCAPES_WORKSPACE');

  assertPlainObject(value.env,'env');
  const entries=Object.entries(value.env);
  if (entries.length>MAX_ENV_COUNT) throw new Error('ENV_TOO_LARGE');
  const env:Record<string,string>={};
  for (const [key,raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`ENV_KEY_INVALID:${key}`);
    if (typeof raw!=='string' || raw.includes('\0') || Buffer.byteLength(raw,'utf8')>MAX_ENV_VALUE_BYTES) {
      throw new Error(`ENV_VALUE_INVALID:${key}`);
    }
    env[key]=raw;
  }

  assertSafeIntegerRange(value.timeout_ms,'timeout_ms',1,MAX_TIMEOUT_MS);
  assertSafeIntegerRange(value.stdout_max_bytes,'stdout_max_bytes',0,MAX_CAPTURE_BYTES);
  assertSafeIntegerRange(value.stderr_max_bytes,'stderr_max_bytes',0,MAX_CAPTURE_BYTES);

  return {
    schema:PROCESS_SPEC_SCHEMA,
    executable:value.executable,
    argv,
    cwd:clean,
    env,
    timeout_ms:value.timeout_ms,
    stdout_max_bytes:value.stdout_max_bytes,
    stderr_max_bytes:value.stderr_max_bytes,
  };
}

export function encodeProcessSpec(spec:ProcessSpecV1):{
  bytes:Buffer;
  base64:string;
  sha256:string;
} {
  const validated=validateProcessSpec(spec);
  const bytes=Buffer.from(JSON.stringify(validated),'utf8');
  if (bytes.length>MAX_SPEC_BYTES) throw new Error('EXECUTION_SPEC_TOO_LARGE');
  return {
    bytes,
    base64:bytes.toString('base64'),
    sha256:sha256Tagged(bytes),
  };
}

export function decodeProcessSpec(execution:ComputationExecutionV1):ProcessSpecV1 {
  validateComputationExecution(execution);
  const bytes=decodeCanonicalBase64(execution.execution_spec_base64);
  let parsed:unknown;
  try {
    parsed=JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('EXECUTION_SPEC_JSON_INVALID');
  }
  return validateProcessSpec(parsed);
}

export function validateComputationExecution(value:unknown):ComputationExecutionV1 {
  assertPlainObject(value,'computation_execution');
  assertExactKeys(value,[
    'schema',
    'run_id',
    'obligation_id',
    'claimed_revision',
    'execution_generation',
    'execution_authority_commit',
    'execution_capability',
    'execution_capability_sha256',
    'execution_spec_base64',
    'execution_spec_sha256',
  ],[],'computation_execution');

  if (value.schema!==COMPUTATION_EXECUTION_SCHEMA) throw new Error('COMPUTATION_EXECUTION_SCHEMA_MISMATCH');
  assertBoundedString(value.run_id,'run_id',256);
  assertBoundedString(value.obligation_id,'obligation_id',512);
  assertBoundedString(value.claimed_revision,'claimed_revision',256);
  assertSafeIntegerRange(value.execution_generation,'execution_generation',1,Number.MAX_SAFE_INTEGER);
  assertBoundedString(value.execution_authority_commit,'execution_authority_commit',256);
  assertBoundedString(value.execution_capability,'execution_capability',4096);
  assertSha256Hex(value.execution_capability_sha256,'execution_capability_sha256');
  if (sha256Hex(value.execution_capability)!==value.execution_capability_sha256) {
    throw new Error('EXECUTION_CAPABILITY_DIGEST_MISMATCH');
  }

  const specBytes=decodeCanonicalBase64(value.execution_spec_base64);
  assertSha256Tagged(value.execution_spec_sha256,'execution_spec_sha256');
  if (sha256Tagged(specBytes)!==value.execution_spec_sha256) {
    throw new Error('EXECUTION_SPEC_DIGEST_MISMATCH');
  }

  return {
    schema:COMPUTATION_EXECUTION_SCHEMA,
    run_id:value.run_id,
    obligation_id:value.obligation_id,
    claimed_revision:value.claimed_revision,
    execution_generation:value.execution_generation,
    execution_authority_commit:value.execution_authority_commit,
    execution_capability:value.execution_capability,
    execution_capability_sha256:value.execution_capability_sha256,
    execution_spec_base64:value.execution_spec_base64,
    execution_spec_sha256:value.execution_spec_sha256,
  };
}

export function computationExecution(
  permit:ExecutionPermit,
  spec:ProcessSpecV1,
):ComputationExecutionV1 {
  const encoded=encodeProcessSpec(spec);
  return validateComputationExecution({
    schema:COMPUTATION_EXECUTION_SCHEMA,
    run_id:permit.id,
    obligation_id:permit.obligation_id,
    claimed_revision:permit.claimed_revision,
    execution_generation:permit.execution_generation,
    execution_authority_commit:permit.execution_authority_commit,
    execution_capability:permit.execution_capability,
    execution_capability_sha256:permit.execution_capability_sha256,
    execution_spec_base64:encoded.base64,
    execution_spec_sha256:encoded.sha256,
  });
}

export function executionIdentity(execution:ComputationExecutionV1):ExecutionIdentityV1 {
  return {
    run_id:execution.run_id,
    execution_generation:execution.execution_generation,
    execution_authority_commit:execution.execution_authority_commit,
  };
}

export function executionIdentityKey(identity:ExecutionIdentityV1):string {
  return JSON.stringify([
    identity.run_id,
    identity.execution_generation,
    identity.execution_authority_commit,
  ]);
}


export function validateComputationEvidence(value:unknown):ComputationAttemptEvidenceV1 {
  assertPlainObject(value,'computation_evidence');
  assertExactKeys(value,[
    'schema',
    'run_id',
    'obligation_id',
    'claimed_revision',
    'execution_generation',
    'execution_authority_commit',
    'execution_capability_sha256',
    'execution_spec_sha256',
    'outcome',
    'stdout_sha256',
    'stdout_truncated',
    'stderr_sha256',
    'stderr_truncated',
  ],[
    'exit_code',
    'signal',
    'stdout_base64',
    'stderr_base64',
    'error',
  ],'computation_evidence');

  if (value.schema!==COMPUTATION_EVIDENCE_SCHEMA) {
    throw new Error('COMPUTATION_EVIDENCE_SCHEMA_MISMATCH');
  }
  assertBoundedString(value.run_id,'run_id',256);
  assertBoundedString(value.obligation_id,'obligation_id',512);
  assertBoundedString(value.claimed_revision,'claimed_revision',256);
  assertSafeIntegerRange(value.execution_generation,'execution_generation',1,Number.MAX_SAFE_INTEGER);
  assertBoundedString(value.execution_authority_commit,'execution_authority_commit',256);
  assertSha256Hex(value.execution_capability_sha256,'execution_capability_sha256');
  assertSha256Tagged(value.execution_spec_sha256,'execution_spec_sha256');
  if (!['completed','failed','cancelled'].includes(String(value.outcome))) {
    throw new Error('COMPUTATION_EVIDENCE_OUTCOME_INVALID');
  }
  if (value.exit_code!==undefined) {
    assertSafeIntegerRange(value.exit_code,'exit_code',0,255);
  }
  if (value.signal!==undefined && (typeof value.signal!=='string' || value.signal.length===0)) {
    throw new Error('COMPUTATION_EVIDENCE_SIGNAL_INVALID');
  }
  if (value.stdout_base64!==undefined) {
    decodeCanonicalBase64(
      value.stdout_base64,
      MAX_CAPTURE_BYTES,
      'COMPUTATION_EVIDENCE_STDOUT_BASE64_INVALID',
    );
  }
  if (value.stderr_base64!==undefined) {
    decodeCanonicalBase64(
      value.stderr_base64,
      MAX_CAPTURE_BYTES,
      'COMPUTATION_EVIDENCE_STDERR_BASE64_INVALID',
    );
  }
  assertSha256Tagged(value.stdout_sha256,'stdout_sha256');
  assertSha256Tagged(value.stderr_sha256,'stderr_sha256');
  if (typeof value.stdout_truncated!=='boolean' || typeof value.stderr_truncated!=='boolean') {
    throw new Error('COMPUTATION_EVIDENCE_TRUNCATION_INVALID');
  }
  if (value.error!==undefined && typeof value.error!=='string') {
    throw new Error('COMPUTATION_EVIDENCE_ERROR_INVALID');
  }

  return value as unknown as ComputationAttemptEvidenceV1;
}

function assertCapturedStreamForSpec(
  base64:string|undefined,
  digest:string,
  truncated:boolean,
  maxBytes:number,
  stream:'stdout'|'stderr',
):void {
  const captured=base64===undefined
    ? Buffer.alloc(0)
    : decodeCanonicalBase64(
        base64,
        maxBytes,
        `COMPUTATION_EVIDENCE_${stream.toUpperCase()}_BASE64_INVALID`,
      );
  if (truncated && captured.length!==maxBytes) {
    throw new Error(`COMPUTATION_EVIDENCE_${stream.toUpperCase()}_TRUNCATION_MISMATCH`);
  }
  if (!truncated && sha256Tagged(captured)!==digest) {
    throw new Error(`COMPUTATION_EVIDENCE_${stream.toUpperCase()}_DIGEST_MISMATCH`);
  }
}

export function assertComputationEvidenceFor(
  evidence:ComputationAttemptEvidenceV1,
  execution:ComputationExecutionV1,
):void {
  validateComputationEvidence(evidence);
  if (evidence.schema!==COMPUTATION_EVIDENCE_SCHEMA) {
    throw new Error('COMPUTATION_EVIDENCE_SCHEMA_MISMATCH');
  }
  if (
    evidence.run_id!==execution.run_id
    || evidence.obligation_id!==execution.obligation_id
    || evidence.claimed_revision!==execution.claimed_revision
    || evidence.execution_generation!==execution.execution_generation
    || evidence.execution_authority_commit!==execution.execution_authority_commit
    || evidence.execution_capability_sha256!==execution.execution_capability_sha256
  ) {
    throw new Error('COMPUTATION_EVIDENCE_AUTHORITY_MISMATCH');
  }
  if (evidence.execution_spec_sha256!==execution.execution_spec_sha256) {
    throw new Error('COMPUTATION_EVIDENCE_SPEC_MISMATCH');
  }

  const spec=decodeProcessSpec(execution);
  assertCapturedStreamForSpec(
    evidence.stdout_base64,
    evidence.stdout_sha256,
    evidence.stdout_truncated,
    spec.stdout_max_bytes,
    'stdout',
  );
  assertCapturedStreamForSpec(
    evidence.stderr_base64,
    evidence.stderr_sha256,
    evidence.stderr_truncated,
    spec.stderr_max_bytes,
    'stderr',
  );
}
