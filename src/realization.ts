import type {
  Obligation,
  ResultAcceptance,
  WorkerResultEnvelope,
} from './model.ts';
import { canonicalDigest } from './digest.ts';

export const WORKER_RESULT_SCHEMA='overcenter-worker-result-v1' as const;

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

export function workerResult(result:Record<string,unknown>):WorkerResultEnvelope {
  return {
    schema:WORKER_RESULT_SCHEMA,
    result:structuredClone(result),
  };
}

export function verifyWorkerResult(
  obligation:Obligation,
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
    keys.length!==2
    || keys[0]!=='result'
    || keys[1]!=='schema'
    || record.schema!==WORKER_RESULT_SCHEMA
    || !record.result
    || typeof record.result!=='object'
    || Array.isArray(record.result)
  ) {
    throw new Error('WORKER_RESULT_INVALID');
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
