export type WorkloadKind='computation'|'effect';
export type Receipt='none'|'waiting'|'recovery'|'done'|'ready';

export interface LegacyPermit {
  generation:number;
  authority:number;
}

export interface LegacyState {
  kind:WorkloadKind;
  claimed:boolean;
  generation:number;
  authority:number;
  unresolvedEffect:boolean;
  receipt:Receipt;
  containmentTerminated:boolean;
  writes:number;
}

export const initialLegacy=(kind:WorkloadKind):LegacyState=>({
  kind,
  claimed:false,
  generation:0,
  authority:0,
  unresolvedEffect:false,
  receipt:'none',
  containmentTerminated:false,
  writes:0,
});

const current=(state:LegacyState,permit:LegacyPermit):void=>{
  if (!state.claimed || permit.generation!==state.generation || permit.authority!==state.authority) {
    throw new Error('STALE_EXECUTION_GENERATION');
  }
};

export function claimLegacy(state:LegacyState):LegacyPermit {
  if (state.claimed) throw new Error('ALREADY_CLAIMED');
  state.claimed=true;
  state.generation=1;
  state.authority+=1;
  state.writes+=1;
  return {generation:state.generation,authority:state.authority};
}

export function deferLegacy(state:LegacyState,permit:LegacyPermit):void {
  current(state,permit);
  if (state.receipt!=='none') throw new Error('NOT_EXECUTING');
  state.receipt='waiting';
  state.writes+=1;
}

export function beginEffectLegacy(state:LegacyState,permit:LegacyPermit):void {
  current(state,permit);
  if (state.kind!=='effect') throw new Error('NOT_EFFECTFUL');
  if (state.receipt!=='none') throw new Error('NOT_EXECUTING');
  if (state.unresolvedEffect) throw new Error('UNRESOLVED_EFFECT');
  state.unresolvedEffect=true;
  state.writes+=1;
}

export function interruptLegacy(state:LegacyState,permit:LegacyPermit):void {
  current(state,permit);
  if (state.receipt!=='none') throw new Error('NOT_EXECUTING');
  state.receipt='recovery';
  state.writes+=1;
}

export function proveContainmentTerminatedLegacy(state:LegacyState):void {
  if (state.kind!=='computation') throw new Error('NOT_COMPUTATION');
  state.containmentTerminated=true;
}

export function acquireExecutionLegacy(state:LegacyState):LegacyPermit {
  if (!state.claimed || !['waiting','recovery'].includes(state.receipt)) throw new Error('AUTHORITY_LOST');
  if (state.kind==='computation' && state.receipt==='recovery' && !state.containmentTerminated) {
    throw new Error('CONTAINMENT_TERMINATION_UNPROVEN');
  }
  state.generation+=1;
  state.authority+=1;
  state.writes+=1;
  return {generation:state.generation,authority:state.authority};
}

export function settlePresentLegacy(state:LegacyState,permit:LegacyPermit):void {
  current(state,permit);
  if (state.receipt==='done' || state.receipt==='ready') throw new Error('TERMINAL');
  state.receipt='done';
  state.unresolvedEffect=false;
  state.writes+=1;
}

export function settleAbsentLegacy(state:LegacyState,permit:LegacyPermit):void {
  current(state,permit);
  if (state.kind!=='effect') throw new Error('ABSENCE_ONLY_FOR_EFFECT');
  if (!state.unresolvedEffect) throw new Error('NO_UNRESOLVED_EFFECT');
  state.receipt='ready';
  state.unresolvedEffect=false;
  state.writes+=1;
}
