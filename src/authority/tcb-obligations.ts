import type { ObligationInput } from './facts.ts';
import { normalizeObligation } from './facts.ts';
import { validateSourceTaskPacket } from '../source/source-obligation.ts';
import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';
import type { RepositorySnapshot } from '../evidence/repository-snapshot.ts';
import type { ProjectGraphProducer } from './project-graph.ts';

export const TCB_OBLIGATIONS_SCHEMA = 'overcenter-tcb-obligations/v1' as const;
export const TCB_OBLIGATIONS_PATH = '.overcenter/tcb-obligations.json' as const;
export const TCB_OBLIGATION_PREFIX = 'tcb:' as const;

const FINDING_KINDS = new Set([
  'tcb-growth',
  'hostile-evidence-stale',
  'hostile-evidence-missing',
  'external-assumption-added',
  'trust-concentration',
]);

const EXECUTABLE_FINDING_KINDS = new Set([
  'tcb-growth',
  'hostile-evidence-stale',
  'trust-concentration',
]);

export function compileTcbObligations(value: unknown): ObligationInput[] {
  if (!isData(value)) throw new Error('TCB_OBLIGATIONS_INVALID');
  assertExactKeys(value, ['schema', 'obligations'], [], 'TCB_OBLIGATIONS_INVALID');
  if (value.schema !== TCB_OBLIGATIONS_SCHEMA) {
    throw new Error('TCB_OBLIGATIONS_SCHEMA_MISMATCH');
  }
  if (!Array.isArray(value.obligations)) {
    throw new Error('TCB_OBLIGATIONS_LIST_INVALID');
  }

  return value.obligations.map((candidate, index) => {
    if (!isData(candidate)) {
      throw new Error(`TCB_OBLIGATION_INVALID:${index}`);
    }
    assertExactKeys(
      candidate,
      ['id', 'kind', 'scope', 'task', 'evidence'],
      [],
      `TCB_OBLIGATION_INVALID:${index}`,
    );
    assertNonEmptyString(candidate.id, `TCB_OBLIGATION_ID_INVALID:${index}`);
    if (!candidate.id.startsWith(TCB_OBLIGATION_PREFIX)) {
      throw new Error(`TCB_OBLIGATION_ID_NAMESPACE_INVALID:${index}`);
    }
    if (typeof candidate.kind !== 'string' || !FINDING_KINDS.has(candidate.kind)) {
      throw new Error(`TCB_OBLIGATION_KIND_INVALID:${index}`);
    }
    assertNonEmptyString(candidate.scope, `TCB_OBLIGATION_SCOPE_INVALID:${index}`);
    if (!isData(candidate.evidence)) {
      throw new Error(`TCB_OBLIGATION_EVIDENCE_INVALID:${index}`);
    }
    const task = validateSourceTaskPacket(candidate.task);
    if (EXECUTABLE_FINDING_KINDS.has(candidate.kind)) {
      return normalizeObligation({
        id: candidate.id,
        packet: validateSourceTaskPacket({
          ...task,
          acceptance: {
            verifier: 'tcb-finding-absent/v1',
            finding_id: candidate.id,
          },
          context: {
            schema: 'overcenter-tcb-finding/v1',
            finding_kind: candidate.kind,
            scope: candidate.scope,
            evidence: structuredClone(candidate.evidence),
          },
        }),
        postcondition: { verifier: 'source-integration/v1' },
      });
    }

    return normalizeObligation({
      id: candidate.id,
      packet: {
        schema: 'overcenter-tcb-finding/v1',
        kind: 'judgment-required',
        finding_kind: candidate.kind,
        scope: candidate.scope,
        source_task: task,
        evidence: structuredClone(candidate.evidence),
      },
      postcondition: {
        verifier: 'operator-judgment/v1',
        subject: {
          kind: 'tcb-remediation',
          finding_id: candidate.id,
          finding_kind: candidate.kind,
          scope: candidate.scope,
        },
      },
    });
  });
}

export const tcbObligationsGraphProducer: ProjectGraphProducer = Object.freeze({
  id: 'tcb-obligations',
  input_paths: [TCB_OBLIGATIONS_PATH],
  managed_prefixes: [TCB_OBLIGATION_PREFIX],
  produce(snapshot: RepositorySnapshot) {
    let value: unknown;
    try {
      value = JSON.parse(snapshot.bytes(TCB_OBLIGATIONS_PATH).toString('utf8'));
    } catch {
      throw new Error('TCB_OBLIGATIONS_JSON_INVALID');
    }
    return compileTcbObligations(value);
  },
});
