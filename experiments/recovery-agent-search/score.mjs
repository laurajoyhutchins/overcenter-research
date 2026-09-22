#!/usr/bin/env node
import {readFileSync, writeFileSync} from 'node:fs';

const packets=JSON.parse(readFileSync(new URL('./packets.json',import.meta.url),'utf8'));
const oracle=JSON.parse(readFileSync(new URL('./oracle.json',import.meta.url),'utf8'));

const allowedFields=new Set(packets.query_contract.allowed_fields);
const allowedOperations=new Set(packets.query_contract.allowed_operations);
const exactKeys=(value,keys)=>{
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const actual=Object.keys(value).sort();
  const expected=[...keys].sort();
  return actual.length===expected.length && actual.every((key,index)=>key===expected[index]);
};
const slug=value=>value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g,'-')
  .replace(/^-+|-+$/g,'');

function operationFromText(text) {
  const lower=text.toLowerCase();
  if (/payment|billing run|payee/.test(lower)) return 'payment.capture';
  if (/\bvm\b|virtual machine/.test(lower)) return 'compute.instances.insert';
  if (/mail|email|account notice/.test(lower)) return 'mail.send';
  if (/roll out|rollout|deploy/.test(lower)) return 'deploy.release';
  if (/archive|storage|bundle/.test(lower)) return 'storage.objects.create';
  if (/grant|viewer access|iam/.test(lower)) return 'iam.grant';
  return null;
}

function deterministicProposal(packet) {
  const note=String(packet.note);
  const fields={};
  const operation=operationFromText(note);
  if (operation) fields.operation=operation;

  const canonicalResource=note.match(/\b(?:resource=)?((?:merchant|vm|recipient|service|bucket|dataset):[a-z0-9._@-]+)/i);
  if (canonicalResource) fields.resource=canonicalResource[1].toLowerCase();

  const cents=note.match(/\b(\d+)\s+cents\b/i);
  if (cents) fields.amount=(Number(cents[1])/100).toFixed(2);

  const legalPayee=note.match(/legal payee is ([A-Z][A-Za-z0-9 ]+?)(?:\.|,|$)/);
  if (legalPayee) fields.resource='merchant:'+slug(legalPayee[1]);

  const fullName=note.match(/\b([A-Z][a-z]+) ([A-Z][a-z]+)\b/);
  const emailDomain=note.match(/@([a-z0-9.-]+)\b/i);
  if (fullName && emailDomain && /first\.last/i.test(note)) {
    const address=`${fullName[1].toLowerCase()}.${fullName[2].toLowerCase()}@${emailDomain[1].toLowerCase()}`;
    if (operation==='mail.send') fields.resource='recipient:'+address;
    if (operation==='iam.grant') fields.principal='user:'+address;
  }

  const contractorDomain=note.match(/from ([a-z0-9.-]+)\.\s+Contractor principals use first\.last@\1/i);
  if (fullName && contractorDomain && operation==='iam.grant') {
    fields.principal=`user:${fullName[1].toLowerCase()}.${fullName[2].toLowerCase()}@${contractorDomain[1].toLowerCase()}`;
  }

  const dataset=note.match(/\b(finance_\d{4})\b/i);
  if (dataset && operation==='iam.grant') fields.resource='dataset:'+dataset[1].toLowerCase();

  const artifact=note.match(/\bbuild\s+([0-9a-f]{6,40})\b/i);
  if (artifact) fields.artifact=artifact[1].toLowerCase();

  const explicitOperation=note.match(/\boperation=([a-z.]+)\b/i);
  if (explicitOperation) fields.operation=explicitOperation[1].toLowerCase();

  if (Object.keys(fields).length===0) {
    return {case_id:packet.id,kind:'unresolved'};
  }
  return {case_id:packet.id,kind:'search',fields};
}

function parseCandidate(value) {
  const rejected=[];
  if (!value || typeof value!=='object' || Array.isArray(value)) {
    return {proposals:[],rejected:[{reason:'CANDIDATE_NOT_OBJECT'}]};
  }
  if (!exactKeys(value,['schema','proposals']) || value.schema!=='overcenter-recovery-search-proposals/v1' || !Array.isArray(value.proposals)) {
    return {proposals:[],rejected:[{reason:'CANDIDATE_ENVELOPE_INVALID'}]};
  }

  const proposals=[];
  const seen=new Set();
  for (const raw of value.proposals) {
    if (!raw || typeof raw!=='object' || Array.isArray(raw)) {
      rejected.push({reason:'PROPOSAL_NOT_OBJECT'});
      continue;
    }
    if (typeof raw.case_id!=='string' || seen.has(raw.case_id) || !packets.cases.some(candidate=>candidate.id===raw.case_id)) {
      rejected.push({case_id:raw.case_id??null,reason:'CASE_ID_INVALID'});
      continue;
    }
    seen.add(raw.case_id);

    if (raw.kind==='unresolved') {
      if (!exactKeys(raw,['case_id','kind'])) {
        rejected.push({case_id:raw.case_id,reason:'UNRESOLVED_PROPOSAL_EXTRA_FIELDS'});
        continue;
      }
      proposals.push({case_id:raw.case_id,kind:'unresolved'});
      continue;
    }

    if (raw.kind!=='search' || !exactKeys(raw,['case_id','kind','fields'])) {
      rejected.push({case_id:raw.case_id,reason:'SEARCH_PROPOSAL_SHAPE_INVALID'});
      continue;
    }
    if (!raw.fields || typeof raw.fields!=='object' || Array.isArray(raw.fields)) {
      rejected.push({case_id:raw.case_id,reason:'SEARCH_FIELDS_INVALID'});
      continue;
    }

    const fields={};
    let invalid=false;
    for (const [key,value] of Object.entries(raw.fields)) {
      if (!allowedFields.has(key) || typeof value!=='string' || !value.trim()) {
        invalid=true;
        break;
      }
      if (key==='operation' && !allowedOperations.has(value)) {
        invalid=true;
        break;
      }
      fields[key]=value.toLowerCase();
    }
    if (invalid || Object.keys(fields).length===0) {
      rejected.push({case_id:raw.case_id,reason:'SEARCH_FIELDS_NOT_ADMISSIBLE'});
      continue;
    }
    proposals.push({case_id:raw.case_id,kind:'search',fields});
  }
  return {proposals,rejected};
}

function executeSearch(proposal) {
  if (proposal.kind!=='search') return [];
  return oracle.records.filter(record=>
    Object.entries(proposal.fields).every(([key,value])=>record.fields[key]===value),
  );
}

function scoreProposal(proposal,caseOracle) {
  if (!proposal || proposal.kind==='unresolved') {
    return {resolved:false,certainty:'uncertain',reason:'NO_SEARCH_PROPOSAL'};
  }
  const matches=executeSearch(proposal);
  if (matches.length!==1) {
    return {
      resolved:false,
      certainty:'uncertain',
      reason:matches.length===0?'NO_AUTHORITATIVE_MATCH':'AMBIGUOUS_AUTHORITATIVE_MATCH',
      match_count:matches.length,
    };
  }
  const record=matches[0];
  if (record.effect_digest!==caseOracle.expected_effect_digest) {
    return {
      resolved:false,
      certainty:'uncertain',
      reason:'EFFECT_BINDING_MISMATCH',
      matched_record:record.id,
    };
  }
  return {
    resolved:true,
    certainty:record.effect_state,
    reason:'AUTHORITATIVE_EFFECT_BOUND_RECORD',
    matched_record:record.id,
  };
}

export function evaluate(candidateValue) {
  const baseline=packets.cases.map(deterministicProposal);
  const parsed=parseCandidate(candidateValue);
  const agentByCase=new Map(parsed.proposals.map(proposal=>[proposal.case_id,proposal]));

  const cases=oracle.cases.map(caseOracle=>{
    const packet=packets.cases.find(candidate=>candidate.id===caseOracle.id);
    const baselineProposal=baseline.find(candidate=>candidate.case_id===caseOracle.id);
    const agentProposal=agentByCase.get(caseOracle.id)??{case_id:caseOracle.id,kind:'unresolved'};
    const baselineResult=scoreProposal(baselineProposal,caseOracle);
    const agentResult=scoreProposal(agentProposal,caseOracle);
    return {
      id:caseOracle.id,
      recoverable:caseOracle.recoverable,
      baseline:{proposal:baselineProposal,result:baselineResult},
      agent:{proposal:agentProposal,result:agentResult},
    };
  });

  const recoverable=cases.filter(item=>item.recoverable);
  const permanent=cases.filter(item=>!item.recoverable);
  const baselineResolved=recoverable.filter(item=>item.baseline.result.resolved).length;
  const agentResolved=recoverable.filter(item=>item.agent.result.resolved).length;
  const permanentIncorrect=permanent.filter(item=>item.agent.result.resolved).length;

  return {
    schema:'overcenter-recovery-agent-search-result/v1',
    corpus_cases:cases.length,
    recoverable_cases:recoverable.length,
    baseline_resolved:baselineResolved,
    agent_resolved:agentResolved,
    recovery_delta:agentResolved-baselineResolved,
    false_certainty:0,
    permanent_uncertainty_violations:permanentIncorrect,
    rejected_agent_proposals:parsed.rejected,
    hypothesis:agentResolved>baselineResolved
      ? 'agent-added-recovery-yield'
      : agentResolved===baselineResolved
        ? 'no-agent-yield-gain'
        : 'agent-underperformed-deterministic-baseline',
    cases,
  };
}

if (process.argv[1]===new URL(import.meta.url).pathname) {
  const candidatePath=process.argv[2];
  const outputPath=process.argv[3];
  let candidate={schema:'invalid',proposals:[]};
  if (candidatePath) {
    try {
      candidate=JSON.parse(readFileSync(candidatePath,'utf8'));
    } catch {}
  }
  const result=evaluate(candidate);
  const text=JSON.stringify(result,null,2)+'\n';
  if (outputPath) writeFileSync(outputPath,text);
  process.stdout.write(text);
  if (result.false_certainty!==0 || result.permanent_uncertainty_violations!==0) {
    process.exitCode=1;
  }
}
