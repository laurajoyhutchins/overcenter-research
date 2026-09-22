export interface UnsafeEffectClockState {
  claimed:boolean;
  mutationAttempt:number;
  unresolvedEffect:boolean;
  receipt:'none'|'recovery'|'done';
}

export const initialUnsafeEffectClock=():UnsafeEffectClockState=>({
  claimed:false,
  mutationAttempt:0,
  unresolvedEffect:false,
  receipt:'none',
});

export function claimUnsafeEffectClock(state:UnsafeEffectClockState):number {
  state.claimed=true;
  state.mutationAttempt=1;
  return state.mutationAttempt;
}

export function beginEffectUnsafeEffectClock(state:UnsafeEffectClockState,attempt:number):void {
  if (!state.claimed || attempt!==state.mutationAttempt) throw new Error('STALE_ATTEMPT');
  state.unresolvedEffect=true;
}

export function interruptUnsafeEffectClock(state:UnsafeEffectClockState,attempt:number):void {
  if (attempt!==state.mutationAttempt) throw new Error('STALE_ATTEMPT');
  state.receipt='recovery';
}

// If the single clock denotes the mutation attempt, recovery must preserve it
// while the mutation outcome is unresolved. That means it cannot also fence
// the dead worker: both old and recovery holders possess the same identity.
export function recoverUnsafeEffectClock(state:UnsafeEffectClockState):number {
  if (state.receipt!=='recovery' || !state.unresolvedEffect) throw new Error('NOT_RECOVERING');
  return state.mutationAttempt;
}

export function authorityAcceptedUnsafeEffectClock(
  state:UnsafeEffectClockState,
  attempt:number,
):boolean {
  return state.claimed && attempt===state.mutationAttempt;
}
