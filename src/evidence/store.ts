import type { EvidenceRef } from './reference.ts';

export interface EvidenceStore {
  put(bytes: Uint8Array): EvidenceRef;
  get(ref: EvidenceRef): Uint8Array;
}
