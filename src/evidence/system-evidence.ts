import type { Obligation, Work } from '../model.ts';
import type { Receipt } from '../authority/engine.ts';

export const SYSTEM_EVIDENCE_KIND = 'system-evidence' as const;

export interface SystemEvidenceAuthority {
  head(): string | null;
  reconcileGraph(desired: Obligation[], expectedRevision: string): unknown;
  inspect(): Work[];
  claim(id: string, expectedRevision: string): ReturnType<
    import('../authority/engine.ts').KernelCore['claim']
  >;
  resolveAsync(
    permit: ReturnType<import('../authority/engine.ts').KernelCore['claim']>,
    diagnostic?: Record<string, unknown>,
  ): Promise<Receipt>;
}

export interface SystemEvidenceDefinition {
  obligation(): Obligation;
}

export function isSystemEvidenceWork(work: Pick<Work, 'packet'>): boolean {
  return work.packet.kind === SYSTEM_EVIDENCE_KIND;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function reconcileSystemEvidence(
  authority: SystemEvidenceAuthority,
  definition: SystemEvidenceDefinition,
  {
    waitForIdle = false,
    attempts = waitForIdle ? 90 : 16,
    retryDelayMs = 2_000,
  }: {
    waitForIdle?: boolean;
    attempts?: number;
    retryDelayMs?: number;
  } = {},
): Promise<{ state: 'reconciled'; result: unknown } | { state: 'deferred'; reason: 'PROJECT_BUSY' }> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const expectedRevision = authority.head();
    if (!expectedRevision) throw new Error('SYSTEM_EVIDENCE_AUTHORITY_MISSING');
    try {
      return {
        state: 'reconciled',
        result: authority.reconcileGraph([definition.obligation()], expectedRevision),
      };
    } catch (error: unknown) {
      const reason = message(error);
      if (reason === 'STALE_REVISION') continue;
      if (reason === 'PROJECT_BUSY' && waitForIdle) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      if (reason === 'PROJECT_BUSY') return { state: 'deferred', reason };
      throw error;
    }
  }
  throw new Error('SYSTEM_EVIDENCE_RECONCILIATION_EXHAUSTED');
}

export async function settleSystemEvidence(
  authority: SystemEvidenceAuthority,
  definition: SystemEvidenceDefinition,
  {
    verify,
    diagnostic = {},
    attempts = 16,
  }: {
    verify?: () => void | Promise<void>;
    diagnostic?: Record<string, unknown>;
    attempts?: number;
  } = {},
): Promise<
  | {
      state: 'already-done';
      obligation_id: string;
      authority_head: string;
    }
  | {
      state: 'settled';
      obligation_id: string;
      run_id: string;
      settlement_commit: string | null;
      authority_head: string;
    }
> {
  await verify?.();
  await reconcileSystemEvidence(authority, definition, { waitForIdle: true });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const desired = definition.obligation();
    const work = authority.inspect().find((candidate) => candidate.id === desired.id);
    if (!work) throw new Error('SYSTEM_EVIDENCE_OBLIGATION_MISSING');

    const authorityHead = authority.head();
    if (!authorityHead) throw new Error('SYSTEM_EVIDENCE_AUTHORITY_MISSING');

    if (work.status === 'DONE') {
      return {
        state: 'already-done',
        obligation_id: work.id,
        authority_head: authorityHead,
      };
    }
    if (work.status !== 'READY') {
      throw new Error(`SYSTEM_EVIDENCE_OBLIGATION_NOT_READY:${work.status}`);
    }

    try {
      const permit = authority.claim(work.id, work.revision);
      const receipt = await authority.resolveAsync(permit, diagnostic);
      if (receipt.disposition !== 'DONE' || receipt.verified !== true) {
        throw new Error(`SYSTEM_EVIDENCE_NOT_SETTLED:${receipt.disposition}`);
      }
      const settledHead = authority.head();
      if (!settledHead) throw new Error('SYSTEM_EVIDENCE_AUTHORITY_MISSING');
      return {
        state: 'settled',
        obligation_id: work.id,
        run_id: receipt.run_id,
        settlement_commit: receipt.settlement_commit ?? null,
        authority_head: settledHead,
      };
    } catch (error: unknown) {
      const reason = message(error);
      if (reason === 'STALE_REVISION' || reason === 'CLAIM_LOST') continue;
      throw error;
    }
  }
  throw new Error('SYSTEM_EVIDENCE_SETTLEMENT_CONTENTION_EXHAUSTED');
}
