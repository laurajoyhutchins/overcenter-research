import type { Work } from '../model.ts';

export const SYSTEM_EVIDENCE_PACKET_SCHEMA = 'overcenter-system-evidence/v1' as const;
export const SYSTEM_EVIDENCE_KIND = 'system-evidence' as const;

export function isSystemEvidenceWork(work: Pick<Work, 'packet'>): boolean {
  return work.packet.kind === SYSTEM_EVIDENCE_KIND;
}
