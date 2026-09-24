import {
  AGENT_TASK_PACKET_SCHEMA,
  validateAgentTaskPacket,
} from '../execution/assignment-capsule.ts';
import {
  SOURCE_TASK_SCHEMA,
  validateSourceTaskPacket,
} from '../source/source-obligation.ts';
import type { Dependency, Postcondition } from '../model.ts';
import { validatePostcondition } from '../observation/observe.ts';
import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';
import { normalizeObligation, type ObligationInput } from './facts.ts';

export const PROJECT_INTENT_SCHEMA = 'overcenter-project-intent/v1' as const;
export const PROJECT_INTENT_PATH = '.overcenter/project-intent.json' as const;

export function compileProjectIntent(value: unknown): ObligationInput[] {
  if (!isData(value)) throw new Error('PROJECT_INTENT_INVALID');
  assertExactKeys(value, ['schema', 'obligations'], [], 'PROJECT_INTENT_INVALID');
  if (value.schema !== PROJECT_INTENT_SCHEMA) {
    throw new Error('PROJECT_INTENT_SCHEMA_MISMATCH');
  }
  if (!Array.isArray(value.obligations)) {
    throw new Error('PROJECT_INTENT_OBLIGATIONS_INVALID');
  }

  return value.obligations.map((candidate, index) => {
    if (!isData(candidate)) {
      throw new Error(`PROJECT_INTENT_OBLIGATION_INVALID:${index}`);
    }
    assertExactKeys(
      candidate,
      ['id', 'task'],
      ['dependencies', 'postcondition'],
      `PROJECT_INTENT_OBLIGATION_INVALID:${index}`,
    );
    assertNonEmptyString(candidate.id, `PROJECT_INTENT_OBLIGATION_ID_INVALID:${index}`);
    if (!isData(candidate.task)) {
      throw new Error(`PROJECT_INTENT_TASK_INVALID:${index}`);
    }

    if (
      candidate.task.schema === SOURCE_TASK_SCHEMA ||
      candidate.task.kind === 'source-change'
    ) {
      if (candidate.postcondition !== undefined) {
        throw new Error(`PROJECT_INTENT_SOURCE_POSTCONDITION_FORBIDDEN:${index}`);
      }
      const packet = validateSourceTaskPacket(candidate.task);
      return normalizeObligation({
        id: candidate.id,
        ...(candidate.dependencies === undefined
          ? {}
          : { dependencies: structuredClone(candidate.dependencies) }),
        packet: structuredClone(packet),
        postcondition: { verifier: 'source-integration/v1' },
      } as ObligationInput);
    }

    if (candidate.postcondition === undefined) {
      throw new Error(`PROJECT_INTENT_POSTCONDITION_REQUIRED:${index}`);
    }
    assertExactKeys(
      candidate.task,
      ['command', 'required_paths', 'output_path'],
      [],
      `PROJECT_INTENT_TASK_INVALID:${index}`,
    );

    const packet = validateAgentTaskPacket({
      schema: AGENT_TASK_PACKET_SCHEMA,
      kind: 'pure-candidate',
      command: structuredClone(candidate.task.command),
      required_paths: structuredClone(candidate.task.required_paths),
      output_path: candidate.task.output_path,
    });

    const postcondition = structuredClone(candidate.postcondition) as Postcondition;
    validatePostcondition(postcondition);
    return normalizeObligation({
      id: candidate.id,
      ...(candidate.dependencies === undefined
        ? {}
        : { dependencies: structuredClone(candidate.dependencies) as Dependency[] }),
      packet: structuredClone(packet),
      postcondition,
    });
  });
}
