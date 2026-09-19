import type {
  Obligation,
  ResultAcceptance,
  TaskSession,
  WorkerResultEnvelope,
} from './model.ts';
import { canonicalDigest } from './digest.ts';

export const WORKER_RESULT_SCHEMA='overcenter-worker-result-v2' as const;

export interface VerifiedWorkerResult {
  verifier:ResultAcceptance['verifier'];
  result_digest:string;
}

export function validateResultAcceptance(
  acceptance:ResultAcceptance|undefined,
):void {
  if (!acceptance) return;
  if (
    acceptance.verifier!=='canonical-json-sha256/v1'
    || !/^[0-9a-f]{64}$/.test(acceptance.expected_sha256)
  ) {
    throw new Error('INVALID_RESULT_ACCEPTANCE');
  }
}

export function workerResult(
  session:TaskSession,
  result:Record<string,unknown>,
):WorkerResultEnvelope {
  return {
    schema:WORKER_RESULT_SCHEMA,
    task_session_sha256:canonicalDigest(session),
    result:structuredClone(result),
  };
}

export function verifyWorkerResult(
  obligation:Obligation,
  session:TaskSession,
  candidate:unknown,
):VerifiedWorkerResult {
  const acceptance=obligation.result_acceptance;
  if (!acceptance) throw new Error('RESULT_ACCEPTANCE_NOT_CONFIGURED');
  validateResultAcceptance(acceptance);

  if (!candidate || typeof candidate!=='object' || Array.isArray(candidate)) {
    throw new Error('WORKER_RESULT_INVALID');
  }
  const record=candidate as Record<string,unknown>;
  const keys=Object.keys(record).sort();
  if (
    keys.length!==3
    || keys[0]!=='result'
    || keys[1]!=='schema'
    || keys[2]!=='task_session_sha256'
    || record.schema!==WORKER_RESULT_SCHEMA
    || !/^[0-9a-f]{64}$/.test(String(record.task_session_sha256))
    || !record.result
    || typeof record.result!=='object'
    || Array.isArray(record.result)
  ) {
    throw new Error('WORKER_RESULT_INVALID');
  }
  if (record.task_session_sha256!==canonicalDigest(session)) {
    throw new Error('WORKER_RESULT_SESSION_MISMATCH');
  }

  const resultDigest=canonicalDigest(record.result);
  if (resultDigest!==acceptance.expected_sha256) {
    throw new Error('WORKER_RESULT_REJECTED');
  }

  return {
    verifier:acceptance.verifier,
    result_digest:resultDigest,
  };
}
