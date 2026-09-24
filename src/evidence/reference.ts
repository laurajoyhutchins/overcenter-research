import { sha256 } from '../digest.ts';
import { hasExactKeys, isData, isSha256Hex } from '../validation.ts';

export interface EvidenceRef {
  algorithm: 'sha256';
  digest: string;
  byte_length: number;
}

export function evidenceRef(bytes: Uint8Array): EvidenceRef {
  const payload = Buffer.from(bytes);
  return {
    algorithm: 'sha256',
    digest: sha256(payload),
    byte_length: payload.byteLength,
  };
}

export function validateEvidenceRef(value: unknown): EvidenceRef {
  if (!isData(value) || !hasExactKeys(value, ['algorithm', 'byte_length', 'digest'])) {
    throw new Error('INVALID_EVIDENCE_REF');
  }
  const ref = value as Partial<EvidenceRef> & Record<string, unknown>;
  if (ref.algorithm !== 'sha256') throw new Error('INVALID_EVIDENCE_ALGORITHM');
  if (!isSha256Hex(ref.digest)) {
    throw new Error('INVALID_EVIDENCE_DIGEST');
  }
  if (!Number.isSafeInteger(ref.byte_length) || Number(ref.byte_length) < 0) {
    throw new Error('INVALID_EVIDENCE_LENGTH');
  }
  return {
    algorithm: 'sha256',
    digest: ref.digest,
    byte_length: Number(ref.byte_length),
  };
}
