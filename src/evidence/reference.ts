import { createHash } from 'node:crypto';

export interface EvidenceRef {
  algorithm: 'sha256';
  digest: string;
  byte_length: number;
}

export function evidenceRef(bytes: Uint8Array): EvidenceRef {
  const payload = Buffer.from(bytes);
  return {
    algorithm: 'sha256',
    digest: createHash('sha256').update(payload).digest('hex'),
    byte_length: payload.byteLength,
  };
}

export function validateEvidenceRef(value: unknown): EvidenceRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_EVIDENCE_REF');
  }
  const ref = value as Partial<EvidenceRef> & Record<string, unknown>;
  const keys = Object.keys(ref).sort();
  if (keys.join(',') !== 'algorithm,byte_length,digest') {
    throw new Error('INVALID_EVIDENCE_REF');
  }
  if (ref.algorithm !== 'sha256') throw new Error('INVALID_EVIDENCE_ALGORITHM');
  if (typeof ref.digest !== 'string' || !/^[0-9a-f]{64}$/.test(ref.digest)) {
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
