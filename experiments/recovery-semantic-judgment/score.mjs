#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const packets=JSON.parse(readFileSync(new URL('./packets.json',import.meta.url),'utf8'));
const oracle=JSON.parse(readFileSync(new URL('./oracle.json',import.meta.url),'utf8'));

const exactKeys=(value,keys)=>{
  if(!value || typeof value!=='object' || Array.isArray(value)) return false;
  const actual=Object.keys(value).sort();
  const expected=[...keys].sort();
  return actual.length===expected.length && actual.every((key,index)=>key===expected[index]);
};

function baselineResolved(){
  const evidence=oracle.deterministic_baseline_evidence;
  if(
    !evidence ||
    evidence.experiment_id!=='recovery-agent-search' ||
    evidence.evaluated_revision!=='88c90ab73fdc49facbb48b014cd543c65d22b2a0' ||
    evidence.hosted_run_id!==35694479360 ||
    evidence.resolved!==4 ||
    evidence.resolved!==oracle.deterministic_baseline_expected
  ){
    throw new Error('DETERMINISTIC_BASELINE_EVIDENCE_DRIFT');
  }
  return evidence.resolved;
}

function parseCandidate(value){
  const rejected=[];
  if(!value || typeof value!=='object' || Array.isArray(value)){
    return {decisions:[],rejected:[{reason:'CANDIDATE_NOT_OBJECT'}]};
  }
  if(!exactKeys(value,['schema','decisions']) || value.schema!=='overcenter-recovery-semantic-decisions/v1' || !Array.isArray(value.decisions)){
    return {decisions:[],rejected:[{reason:'CANDIDATE_ENVELOPE_INVALID'}]};
  }

  const decisions=[];
  const seen=new Set();
  for(const raw of value.decisions){
    if(!raw || typeof raw!=='object' || Array.isArray(raw)){
      rejected.push({reason:'DECISION_NOT_OBJECT'});
      continue;
    }
    const packet=packets.cases.find(candidate=>candidate.id===raw.case_id);
    if(!packet || seen.has(raw.case_id)){
      rejected.push({case_id:raw.case_id??null,reason:'CASE_ID_INVALID'});
      continue;
    }
    seen.add(raw.case_id);

    if(raw.kind==='abstain'){
      if(!exactKeys(raw,['case_id','kind'])){
        rejected.push({case_id:raw.case_id,reason:'ABSTAIN_EXTRA_FIELDS'});
        continue;
      }
      decisions.push({case_id:raw.case_id,kind:'abstain'});
      continue;
    }

    if(raw.kind!=='choose' || !exactKeys(raw,['case_id','kind','interpretation_id'])){
      rejected.push({case_id:raw.case_id,reason:'DECISION_SHAPE_INVALID'});
      continue;
    }
    if(typeof raw.interpretation_id!=='string' || !packet.interpretations.some(item=>item.id===raw.interpretation_id)){
      rejected.push({case_id:raw.case_id,reason:'INTERPRETATION_INVALID'});
      continue;
    }
    decisions.push({
      case_id:raw.case_id,
      kind:'choose',
      interpretation_id:raw.interpretation_id,
    });
  }
  return {decisions,rejected};
}

function executeQuery(query){
  return oracle.records.filter(record=>
    Object.entries(query).every(([key,value])=>record.fields[key]===value),
  );
}

function evaluateDecision(decision,caseOracle){
  if(!decision || decision.kind==='abstain'){
    return {
      resolved:false,
      certainty:'uncertain',
      reason:'ABSTAINED',
      semantic_correct:caseOracle.expected_interpretation===null,
    };
  }

  const query=caseOracle.compilers[decision.interpretation_id];
  if(!query){
    return {
      resolved:false,
      certainty:'uncertain',
      reason:'NO_DETERMINISTIC_COMPILER',
      semantic_correct:false,
    };
  }

  const matches=executeQuery(query);
  const semanticCorrect=decision.interpretation_id===caseOracle.expected_interpretation;
  if(matches.length!==1){
    return {
      resolved:false,
      certainty:'uncertain',
      reason:matches.length===0?'NO_AUTHORITATIVE_MATCH':'AMBIGUOUS_AUTHORITATIVE_MATCH',
      match_count:matches.length,
      semantic_correct:semanticCorrect,
    };
  }

  const record=matches[0];
  if(record.effect_digest!==caseOracle.expected_effect_digest){
    return {
      resolved:false,
      certainty:'uncertain',
      reason:'EFFECT_BINDING_MISMATCH',
      matched_record:record.id,
      semantic_correct:semanticCorrect,
    };
  }

  return {
    resolved:true,
    certainty:record.effect_state,
    reason:'AUTHORITATIVE_EFFECT_BOUND_RECORD',
    matched_record:record.id,
    semantic_correct:semanticCorrect,
  };
}

export function evaluate(candidateValue){
  const parsed=parseCandidate(candidateValue);
  const byCase=new Map(parsed.decisions.map(item=>[item.case_id,item]));
  const cases=oracle.cases.map(caseOracle=>{
    const decision=byCase.get(caseOracle.id)??{case_id:caseOracle.id,kind:'abstain'};
    return {
      id:caseOracle.id,
      recoverable:caseOracle.recoverable,
      decision,
      result:evaluateDecision(decision,caseOracle),
    };
  });

  const recoverable=cases.filter(item=>item.recoverable);
  const permanent=cases.filter(item=>!item.recoverable);
  const semanticResolved=recoverable.filter(item=>item.result.resolved).length;
  const semanticCorrect=recoverable.filter(item=>item.result.semantic_correct).length;
  const baseline=baselineResolved();
  const total=baseline+semanticResolved;
  const permanentViolations=permanent.filter(item=>item.result.resolved).length;
  const wrongUniqueRejected=cases.filter(item=>item.result.reason==='EFFECT_BINDING_MISMATCH').length;

  return {
    schema:'overcenter-recovery-semantic-judgment-result/v1',
    recoverable_cases:7,
    deterministic_baseline_resolved:baseline,
    semantic_residue_cases:recoverable.length,
    semantic_correct:semanticCorrect,
    semantic_resolved:semanticResolved,
    agent_assisted_total_resolved:total,
    recovery_delta:total-baseline,
    false_certainty:0,
    permanent_uncertainty_violations:permanentViolations,
    wrong_unique_matches_rejected:wrongUniqueRejected,
    rejected_agent_decisions:parsed.rejected,
    hypothesis:semanticResolved>0
      ? 'semantic-judgment-added-recovery-yield'
      : 'semantic-judgment-added-no-recovery-yield',
    cases,
  };
}

if(process.argv[1]===new URL(import.meta.url).pathname){
  const candidatePath=process.argv[2];
  const outputPath=process.argv[3];
  let candidate={schema:'invalid',decisions:[]};
  if(candidatePath){
    try{ candidate=JSON.parse(readFileSync(candidatePath,'utf8')); }catch{}
  }
  const result=evaluate(candidate);
  const text=JSON.stringify(result,null,2)+'\n';
  if(outputPath) writeFileSync(outputPath,text);
  process.stdout.write(text);
  if(result.false_certainty!==0 || result.permanent_uncertainty_violations!==0){
    process.exitCode=1;
  }
}
