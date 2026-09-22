export type Certainty='present'|'absent'|'uncertain';
export type Authority='authoritative'|'advisory';
export type Recoverability='mechanical'|'judgment'|'none';

export interface RecoveryAction {
  id:string;
  cost:number;
  authority:Authority;
  certainty:Certainty;
  requires:string[];
}

export interface RecoveryCase {
  id:string;
  truth:Exclude<Certainty,'uncertain'>;
  recoverability:Recoverability;
  actions:RecoveryAction[];
  judgment?:{
    reason:string;
    future_tool:string;
  };
}

export interface RecoveryCaseView {
  id:string;
  recoverability:Recoverability;
  actions:RecoveryAction[];
  judgment?:RecoveryCase['judgment'];
}

export interface RecoveryState {
  certainty:Certainty;
  status:'RECOVERY_REQUIRED'|'RESOLVED'|'JUDGMENT_REQUIRED'|'UNRESOLVED';
  evidence:string[];
  cost:number;
  consequential_actions:number;
}

export type RecoveryProposal=
  | {kind:'observe';action_id:string}
  | {kind:'request-judgment'}
  | {kind:'search-authoritative-audit';query:string;reason:string}
  | {kind:'retry-effect'}
  | {kind:'assert-certainty';certainty:'present'|'absent'};

export interface RecoveryEvidence {
  authority:Authority;
  certainty:Certainty;
  evidence_id:string;
}

export interface JudgmentSearchCandidate {
  query:string;
  reason:string;
}

function exactKeys(value:object,expected:string[]):boolean {
  const actual=Object.keys(value).sort();
  const wanted=[...expected].sort();
  return actual.length===wanted.length
    && actual.every((key,index)=>key===wanted[index]);
}

function applyEvidenceCertainty(
  state:RecoveryState,
  authority:Authority,
  certainty:Certainty,
):RecoveryState {
  if (authority!=='authoritative' && certainty!=='uncertain') {
    throw new Error('NON_AUTHORITATIVE_CERTAINTY_NOT_ADMISSIBLE');
  }
  if (authority==='authoritative' && certainty!=='uncertain') {
    return {...state,certainty,status:'RESOLVED'};
  }
  return state;
}

export function publicView(scenario:RecoveryCase):RecoveryCaseView {
  return {
    id:scenario.id,
    recoverability:scenario.recoverability,
    actions:structuredClone(scenario.actions),
    ...(scenario.judgment?{judgment:structuredClone(scenario.judgment)}:{}),
  };
}

export function initialState():RecoveryState {
  return {
    certainty:'uncertain',
    status:'RECOVERY_REQUIRED',
    evidence:[],
    cost:0,
    consequential_actions:0,
  };
}

export function observe(
  input:RecoveryCaseView,
  state:RecoveryState,
  actionId:string,
):RecoveryState {
  const action=input.actions.find(candidate=>candidate.id===actionId);
  if (!action) throw new Error('UNKNOWN_RECOVERY_ACTION');
  if (state.evidence.includes(action.id)) throw new Error('RECOVERY_ACTION_ALREADY_USED');
  if (action.requires.some(required=>!state.evidence.includes(required))) {
    throw new Error('RECOVERY_ACTION_PREREQUISITE_MISSING');
  }

  const next:RecoveryState={
    ...state,
    evidence:[...state.evidence,action.id],
    cost:state.cost+action.cost,
  };

  return applyEvidenceCertainty(next,action.authority,action.certainty);
}

export function admitRecoveryEvidence(
  state:RecoveryState,
  evidence:RecoveryEvidence,
):RecoveryState {
  if (
    !evidence
    || typeof evidence.evidence_id!=='string'
    || !evidence.evidence_id.trim()
  ) {
    throw new Error('RECOVERY_EVIDENCE_INVALID');
  }
  if (state.certainty!=='uncertain') return state;
  const next:RecoveryState={
    ...state,
    evidence:state.evidence.includes(evidence.evidence_id)
      ? state.evidence
      : [...state.evidence,evidence.evidence_id],
  };
  return applyEvidenceCertainty(next,evidence.authority,evidence.certainty);
}

export function admitProposal(
  input:RecoveryCaseView,
  state:RecoveryState,
  proposal:RecoveryProposal,
):RecoveryState {
  if (state.certainty!=='uncertain') return state;

  if (proposal.kind==='retry-effect') {
    throw new Error('CONSEQUENTIAL_ACTION_NOT_ADMISSIBLE');
  }
  if (proposal.kind==='assert-certainty') {
    throw new Error('CERTAINTY_ASSERTION_NOT_EVIDENCE');
  }
  if (proposal.kind==='request-judgment') {
    return {...state,status:'JUDGMENT_REQUIRED'};
  }
  if (proposal.kind==='search-authoritative-audit') {
    if (
      state.status!=='JUDGMENT_REQUIRED'
      || input.judgment?.future_tool!=='search-authoritative-audit'
      || !exactKeys(proposal,['kind','query','reason'])
      || !proposal.query.trim()
      || !proposal.reason.trim()
    ) {
      throw new Error('JUDGMENT_SEARCH_CANDIDATE_INVALID');
    }
    return state;
  }
  return observe(input,state,proposal.action_id);
}

export function validateJudgmentSearchCandidate(
  input:RecoveryCaseView,
  state:RecoveryState,
  value:unknown,
):JudgmentSearchCandidate {
  if (
    !value
    || typeof value!=='object'
    || Array.isArray(value)
    || !exactKeys(value,['query','reason'])
  ) {
    throw new Error('JUDGMENT_SEARCH_CANDIDATE_INVALID');
  }
  const raw=value as Record<string,unknown>;
  if (
    typeof raw.query!=='string'
    || typeof raw.reason!=='string'
    || !raw.query.trim()
    || !raw.reason.trim()
  ) {
    throw new Error('JUDGMENT_SEARCH_CANDIDATE_INVALID');
  }
  const proposal:RecoveryProposal={
    kind:'search-authoritative-audit',
    query:raw.query.trim(),
    reason:raw.reason.trim(),
  };
  admitProposal(input,state,proposal);
  return {query:proposal.query,reason:proposal.reason};
}

export function deterministicRecover(input:RecoveryCaseView):RecoveryState {
  let state=initialState();

  while (state.certainty==='uncertain') {
    const candidates=input.actions
      .filter(action=>!state.evidence.includes(action.id))
      .filter(action=>action.requires.every(required=>state.evidence.includes(required)))
      .sort((a,b)=>a.cost-b.cost || a.id.localeCompare(b.id));

    if (candidates.length===0) {
      return {
        ...state,
        status:input.recoverability==='judgment'
          ? 'JUDGMENT_REQUIRED'
          : 'UNRESOLVED',
      };
    }

    state=admitProposal(input,state,{
      kind:'observe',
      action_id:candidates[0].id,
    });
  }

  return state;
}
