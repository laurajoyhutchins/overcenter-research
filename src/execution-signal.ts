export const WORKER_SIGNAL_SCHEMA='overcenter-worker-signal-v1' as const;

export interface EffectReadySignal {
  schema:typeof WORKER_SIGNAL_SCHEMA;
  kind:'effect-ready';
}

export function effectReadySignal():EffectReadySignal {
  return {
    schema:WORKER_SIGNAL_SCHEMA,
    kind:'effect-ready',
  };
}

export function validateEffectReadySignal(candidate:unknown):EffectReadySignal {
  if (!candidate || typeof candidate!=='object' || Array.isArray(candidate)) {
    throw new Error('EFFECT_READY_SIGNAL_INVALID');
  }

  const record=candidate as Record<string,unknown>;
  const keys=Object.keys(record).sort();
  if (
    keys.length!==2
    || keys[0]!=='kind'
    || keys[1]!=='schema'
    || record.schema!==WORKER_SIGNAL_SCHEMA
    || record.kind!=='effect-ready'
  ) {
    throw new Error('EFFECT_READY_SIGNAL_INVALID');
  }

  return effectReadySignal();
}
