import type { ObligationInput } from './authority/facts.ts';
import type { Data, Dependency } from './model.ts';
import type { SemanticEffect } from './semantic-effect.ts';
import { assertExactKeys, assertNonEmptyString, isData } from './validation.ts';

export const SEMANTIC_COMMAND_SCHEMA = 'overcenter-semantic-command' as const;
export const SEMANTIC_COMMAND_SCHEMA_VERSION = 1 as const;

export interface EnsureSemanticCommand {
  schema: typeof SEMANTIC_COMMAND_SCHEMA;
  schema_version: typeof SEMANTIC_COMMAND_SCHEMA_VERSION;
  kind: 'ensure';
  id: string;
  resource: string;
  target: Data;
  desired: Data;
  dependencies?: Dependency[];
}

type AnySemanticEffect = SemanticEffect<any, any, any>;

export interface SemanticEffectRegistry {
  resources(): readonly string[];
  compile(command: unknown): ObligationInput;
}

export function createSemanticEffectRegistry(
  effects: readonly AnySemanticEffect[],
): SemanticEffectRegistry {
  const byResource = new Map<string, AnySemanticEffect>();
  for (const effect of effects) {
    if (byResource.has(effect.resource)) {
      throw new Error(`SEMANTIC_EFFECT_RESOURCE_DUPLICATE:${effect.resource}`);
    }
    byResource.set(effect.resource, effect);
  }
  const resources = Object.freeze([...byResource.keys()].sort());

  return Object.freeze({
    resources: () => resources,
    compile(command: unknown): ObligationInput {
      if (!isData(command)) throw new Error('SEMANTIC_COMMAND_INVALID');
      assertExactKeys(
        command,
        ['schema', 'schema_version', 'kind', 'id', 'resource', 'target', 'desired'],
        ['dependencies'],
        'SEMANTIC_COMMAND_INVALID',
      );
      if (command.schema !== SEMANTIC_COMMAND_SCHEMA) {
        throw new Error('SEMANTIC_COMMAND_SCHEMA_INVALID');
      }
      if (command.schema_version !== SEMANTIC_COMMAND_SCHEMA_VERSION) {
        throw new Error('SEMANTIC_COMMAND_SCHEMA_VERSION_UNSUPPORTED');
      }
      if (command.kind !== 'ensure') throw new Error('SEMANTIC_COMMAND_KIND_UNSUPPORTED');
      assertNonEmptyString(command.id, 'SEMANTIC_COMMAND_ID_INVALID');
      assertNonEmptyString(command.resource, 'SEMANTIC_COMMAND_RESOURCE_INVALID');
      if (!isData(command.target)) throw new Error('SEMANTIC_COMMAND_TARGET_INVALID');
      if (!isData(command.desired)) throw new Error('SEMANTIC_COMMAND_DESIRED_INVALID');
      if (command.dependencies !== undefined && !Array.isArray(command.dependencies)) {
        throw new Error('SEMANTIC_COMMAND_DEPENDENCIES_INVALID');
      }

      const effect = byResource.get(command.resource);
      if (!effect) throw new Error(`SEMANTIC_COMMAND_RESOURCE_UNREGISTERED:${command.resource}`);
      return effect.ensure({
        id: command.id,
        target: command.target,
        desired: command.desired,
        ...(command.dependencies === undefined
          ? {}
          : { dependencies: command.dependencies as Dependency[] }),
      });
    },
  });
}
