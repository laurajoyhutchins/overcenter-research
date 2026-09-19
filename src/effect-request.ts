import { canonicalDigest } from './digest.ts';
import type { Data, Work } from './model.ts';

export const EFFECT_REQUEST_SCHEMA='overcenter-effect-request-v1' as const;

export interface EffectRequest {
  schema:typeof EFFECT_REQUEST_SCHEMA;
  obligation_id:string;
  run_id:string;
  claimed_revision:string;
  effect:Data;
}

export function expectedEffectRequest(work:Work):EffectRequest {
  if (work.status!=='EXECUTING') throw new Error('EFFECT_REQUEST_WORK_NOT_EXECUTING');
  if (!work.run_id) throw new Error('EFFECT_REQUEST_RUN_MISSING');
  if (!work.claimed_revision) throw new Error('EFFECT_REQUEST_REVISION_MISSING');

  const effect=work.packet.effect;
  if (!effect || typeof effect!=='object' || Array.isArray(effect)) {
    throw new Error('EFFECT_REQUEST_EFFECT_MISSING');
  }

  return {
    schema:EFFECT_REQUEST_SCHEMA,
    obligation_id:work.id,
    run_id:work.run_id,
    claimed_revision:work.claimed_revision,
    effect:structuredClone(effect as Data),
  };
}

export function authorizeEffectRequest(
  work:Work,
  candidate:unknown,
):EffectRequest {
  const expected=expectedEffectRequest(work);
  if (!candidate || typeof candidate!=='object' || Array.isArray(candidate)) {
    throw new Error('EFFECT_REQUEST_NOT_AUTHORIZED');
  }

  if (canonicalDigest(candidate)!==canonicalDigest(expected)) {
    throw new Error('EFFECT_REQUEST_NOT_AUTHORIZED');
  }

  return expected;
}
