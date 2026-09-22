export interface UnsafeState {
  claimed:boolean;
  attempt:number;
  unresolvedEffect:boolean;
  receipt:'none'|'recovery'|'done';
}

export const initialUnsafe=():UnsafeState=>({
  claimed:false,
  attempt:0,
  unresolvedEffect:false,
  receipt:'none',
});

export function claimUnsafe(state:UnsafeState):number {
  state.claimed=true;
  state.attempt=1;
  return state.attempt;
}

export function beginEffectUnsafe(state:UnsafeState,attempt:number):void {
  if (!state.claimed || attempt!==state.attempt) throw new Error('STALE_ATTEMPT');
  state.unresolvedEffect=true;
}

export function interruptUnsafe(state:UnsafeState,attempt:number):void {
  if (attempt!==state.attempt) throw new Error('STALE_ATTEMPT');
  state.receipt='recovery';
}

export function recoverUnsafe(state:UnsafeState):number {
  if (state.receipt!=='recovery') throw new Error('NOT_RECOVERING');
  state.attempt+=1;
  return state.attempt;
}

export function mayExecuteUnsafe(state:UnsafeState,attempt:number):boolean {
  return state.claimed && attempt===state.attempt;
}
