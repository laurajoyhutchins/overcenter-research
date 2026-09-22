export type WorkloadKind='computation'|'effect';
export type AttemptPurpose='execute'|'recover';
export type Receipt='none'|'waiting'|'recovery'|'done'|'ready';

export interface AttemptPermit {
  number:number;
  authority:number;
  purpose:AttemptPurpose;
}

export interface CandidateState {
  kind:WorkloadKind;
  claimed:boolean;
  attemptNumber:number;
  authority:number;
  currentPurpose:AttemptPurpose|null;
  unresolvedEffectAttempt:number|null;
  receipt:Receipt;
  containmentTerminated:boolean;
  writes:number;
}

export const initialCandidate=(kind:WorkloadKind):CandidateState=>({
  kind,
  claimed:false,
  attemptNumber:0,
  authority:0,
  currentPurpose:null,
  unresolvedEffectAttempt:null,
  receipt:'none',
  containmentTerminated:false,
  writes:0,
});

const current=(state:CandidateState,permit:AttemptPermit):void=>{
  if (
    !state.claimed
    || permit.number!==state.attemptNumber
    || permit.authority!==state.authority
    || permit.purpose!==state.currentPurpose
  ) throw new Error('STALE_ATTEMPT');
};

function mintAttempt(state:CandidateState,purpose:AttemptPurpose,coCommit=false):AttemptPermit {
  state.attemptNumber+=1;
  state.authority+=1;
  state.currentPurpose=purpose;
  if (!coCommit) state.writes+=1;
  return {number:state.attemptNumber,authority:state.authority,purpose};
}

export function claimCandidate(state:CandidateState):AttemptPermit|null {
  if (state.claimed) throw new Error('ALREADY_CLAIMED');
  state.claimed=true;
  state.writes+=1;
  // Replay-safe computation validates its exact execution context before claim,
  // so claim + initial execute attempt may share one authority CAS.
  return state.kind==='computation' ? mintAttempt(state,'execute',true) : null;
}

export function deferCandidate(state:CandidateState):void {
  if (!state.claimed || state.currentPurpose!==null || state.receipt!=='none') throw new Error('NOT_PREFLIGHT');
  state.receipt='waiting';
  state.writes+=1;
}

export function beginEffectAttempt(state:CandidateState):AttemptPermit {
  if (!state.claimed || state.kind!=='effect' || state.receipt!=='none') throw new Error('NOT_EFFECT_READY');
  if (state.unresolvedEffectAttempt!==null) throw new Error('UNRESOLVED_EFFECT');
  const permit=mintAttempt(state,'execute');
  state.unresolvedEffectAttempt=permit.number;
  return permit;
}

export function interruptCandidate(state:CandidateState,permit:AttemptPermit):void {
  current(state,permit);
  if (permit.purpose!=='execute' || state.receipt!=='none') throw new Error('NOT_EXECUTING');
  state.receipt='recovery';
  state.writes+=1;
}

export function proveContainmentTerminatedCandidate(state:CandidateState):void {
  if (state.kind!=='computation') throw new Error('NOT_COMPUTATION');
  state.containmentTerminated=true;
}

export function beginRecoveryAttempt(state:CandidateState):AttemptPermit {
  if (!state.claimed || state.receipt!=='recovery') throw new Error('NOT_RECOVERING');
  if (state.kind==='computation') {
    if (!state.containmentTerminated) throw new Error('CONTAINMENT_TERMINATION_UNPROVEN');
    state.receipt='none';
    return mintAttempt(state,'execute');
  }
  return mintAttempt(state,'recover');
}

export function settlePresentCandidate(state:CandidateState,permit:AttemptPermit):void {
  current(state,permit);
  if (state.receipt==='done' || state.receipt==='ready') throw new Error('TERMINAL');
  if (state.kind==='effect' && permit.purpose!=='recover' && state.receipt==='recovery') {
    throw new Error('RECOVERY_FENCE_REQUIRED');
  }
  state.receipt='done';
  state.unresolvedEffectAttempt=null;
  state.writes+=1;
}

export function settleAbsentCandidate(state:CandidateState,permit:AttemptPermit):void {
  current(state,permit);
  if (state.kind!=='effect' || permit.purpose!=='recover') throw new Error('RECOVERY_ATTEMPT_REQUIRED');
  if (state.unresolvedEffectAttempt===null) throw new Error('NO_UNRESOLVED_EFFECT');
  state.receipt='ready';
  state.unresolvedEffectAttempt=null;
  state.writes+=1;
}

export function assertMayExecuteCandidate(state:CandidateState,permit:AttemptPermit):void {
  current(state,permit);
  if (permit.purpose!=='execute') throw new Error('RECOVERY_ATTEMPT_CANNOT_EXECUTE');
  if (state.kind==='effect' && state.unresolvedEffectAttempt!==permit.number) {
    throw new Error('EFFECT_ATTEMPT_NOT_RESERVED');
  }
}
