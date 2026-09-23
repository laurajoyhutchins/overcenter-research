import {
  AGENT_TASK_PACKET_SCHEMA,
  validateAgentTaskPacket,
} from '../execution/assignment-capsule.ts';
import { normalizeObligation, type ObligationInput } from './facts.ts';
import { assertExactKeys, isData } from '../validation.ts';

export const PROJECT_INTENT_SCHEMA = 'overcenter-project-intent/v1' as const;
export const PROJECT_INTENT_PATH = '.overcenter/project-intent.json' as const;

export function compileProjectIntent(value: unknown, sourceSha: string): ObligationInput[] {
  const source = sourceSha.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(source)) {
    throw new Error('PROJECT_INTENT_SOURCE_SHA_INVALID');
  }
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
      ['id', 'task', 'postcondition'],
      ['dependencies'],
      `PROJECT_INTENT_OBLIGATION_INVALID:${index}`,
    );
    if (!isData(candidate.task)) {
      throw new Error(`PROJECT_INTENT_TASK_INVALID:${index}`);
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
      source_sha: source,
      command: structuredClone(candidate.task.command),
      required_paths: structuredClone(candidate.task.required_paths),
      output_path: candidate.task.output_path,
    });

    return normalizeObligation({
      id: candidate.id,
      ...(candidate.dependencies === undefined
        ? {}
        : { dependencies: structuredClone(candidate.dependencies) }),
      packet: structuredClone(packet),
      postcondition: structuredClone(candidate.postcondition),
    } as ObligationInput);
  });
}
