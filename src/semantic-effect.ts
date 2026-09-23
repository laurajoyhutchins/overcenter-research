import type { ObligationInput } from './authority/facts.ts';
import {
  effectAdapterCapabilities,
  type EffectVerifier,
  type RegisteredEffectContract,
} from './effect-adapter.ts';
import type { Data, Dependency, Postcondition } from './model.ts';

export const SEMANTIC_EFFECT_INTENT_SCHEMA = 'overcenter-semantic-effect-intent' as const;
export const SEMANTIC_EFFECT_INTENT_SCHEMA_VERSION = 1 as const;

type PostconditionFor<E extends RegisteredEffectContract> = Extract<
  Postcondition,
  { verifier: EffectVerifier<E> }
>;

type PostconditionBody<E extends RegisteredEffectContract> = Omit<PostconditionFor<E>, 'verifier'>;

export interface EnsureRequest<TTarget extends Data, TDesired extends Data> {
  id: string;
  target: TTarget;
  desired: TDesired;
  dependencies?: Dependency[];
}

export interface SemanticEffect<
  E extends RegisteredEffectContract,
  TTarget extends Data,
  TDesired extends Data,
> {
  readonly resource: string;
  readonly effect_contract: E;
  ensure(request: EnsureRequest<TTarget, TDesired>): ObligationInput;
}

export function defineSemanticEffect<
  E extends RegisteredEffectContract,
  TTarget extends Data,
  TDesired extends Data,
>({
  resource,
  effectContract,
  postcondition,
}: {
  resource: string;
  effectContract: E;
  postcondition: (target: Readonly<TTarget>, desired: Readonly<TDesired>) => PostconditionBody<E>;
}): SemanticEffect<E, TTarget, TDesired> {
  if (!resource) throw new Error('SEMANTIC_EFFECT_RESOURCE_REQUIRED');
  const capabilities = effectAdapterCapabilities(effectContract);
  if (!capabilities) throw new Error('SEMANTIC_EFFECT_CONTRACT_UNREGISTERED');

  return Object.freeze({
    resource,
    effect_contract: effectContract,
    ensure({
      id,
      target,
      desired,
      dependencies = [],
    }: EnsureRequest<TTarget, TDesired>): ObligationInput {
      const targetSnapshot = structuredClone(target);
      const desiredSnapshot = structuredClone(desired);
      const body = postcondition(targetSnapshot, desiredSnapshot) as Record<string, unknown>;
      if (Object.hasOwn(body, 'verifier')) {
        throw new Error('SEMANTIC_EFFECT_VERIFIER_IS_REGISTRY_OWNED');
      }

      return {
        id,
        dependencies: structuredClone(dependencies),
        packet: {
          effect_contract: effectContract,
          semantic_intent: {
            schema: SEMANTIC_EFFECT_INTENT_SCHEMA,
            schema_version: SEMANTIC_EFFECT_INTENT_SCHEMA_VERSION,
            kind: 'ensure',
            resource,
            target: targetSnapshot,
            desired: desiredSnapshot,
          },
        },
        postcondition: {
          ...body,
          verifier: capabilities.postcondition_verifier,
        } as PostconditionFor<E>,
      };
    },
  });
}
