import {readFileSync,writeFileSync} from 'node:fs';

import {
  deterministicRecover,
  runJudgmentSearch,
  type RecoveryCaseView,
  type RecoveryEvidence,
} from '../recovery-reasoning/recovery-gate.ts';

type AuditRecord={
  id:string;
  fields:Record<string,string>;
  effect_digest:string;
  effect_state:'present'|'absent';
};

type JudgmentFixture={
  schema:string;
  public:{
    id:string;
    incident:string;
    tool:{
      name:string;
      syntax:string;
      allowed_fields:string[];
      conventions:string[];
    };
  };
  hidden:{
    truth:'present'|'absent';
    expected_effect_digest:string;
    records:AuditRecord[];
  };
};

export function publicAssignment(fixture:JudgmentFixture) {
  return {
    schema:'overcenter-recovery-judgment-assignment/v1',
    case:structuredClone(fixture.public),
  };
}

function parseQuery(
  query:string,
  allowedFields:readonly string[],
):Record<string,string>|null {
  const allowed=new Set(allowedFields);
  const fields:Record<string,string>={};
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const separator=token.indexOf('=');
    if (separator<=0 || separator===token.length-1) return null;
    const key=token.slice(0,separator);
    const value=token.slice(separator+1);
    if (!allowed.has(key) || Object.hasOwn(fields,key)) return null;
    fields[key]=value;
  }
  return Object.keys(fields).length>0?fields:null;
}

function searchEvidence(
  fixture:JudgmentFixture,
  query:string,
):RecoveryEvidence {
  const fields=parseQuery(query,fixture.public.tool.allowed_fields);
  if (!fields) {
    return {
      authority:'authoritative',
      certainty:'uncertain',
      evidence_id:'audit-search:invalid-query',
    };
  }

  const matches=fixture.hidden.records.filter(record=>
    Object.entries(fields).every(([key,value])=>record.fields[key]===value),
  );
  if (matches.length!==1) {
    return {
      authority:'authoritative',
      certainty:'uncertain',
      evidence_id:matches.length===0
        ? 'audit-search:no-hit'
        : 'audit-search:ambiguous',
    };
  }

  const record=matches[0];
  if (record.effect_digest!==fixture.hidden.expected_effect_digest) {
    return {
      authority:'authoritative',
      certainty:'uncertain',
      evidence_id:`${record.id}:effect-binding-mismatch`,
    };
  }

  return {
    authority:'authoritative',
    certainty:record.effect_state,
    evidence_id:record.id,
  };
}

function judgmentInput(fixture:JudgmentFixture):RecoveryCaseView {
  return {
    id:fixture.public.id,
    recoverability:'judgment',
    actions:[],
    judgment:{
      reason:'The authoritative audit service is queryable, but useful parameters require synthesis from unstructured incident evidence.',
      future_tool:fixture.public.tool.name,
    },
  };
}

export function evaluateCandidate(
  fixture:JudgmentFixture,
  candidate:unknown,
) {
  const input=judgmentInput(fixture);
  const baseline=deterministicRecover(input);
  const result=runJudgmentSearch(
    input,
    baseline,
    candidate,
    query=>searchEvidence(fixture,query),
  );
  const falseCertainty=
    result.certainty!=='uncertain'
    && result.certainty!==fixture.hidden.truth
      ? 1
      : 0;

  return {
    schema:'overcenter-recovery-judgment-result/v1',
    baseline_status:baseline.status,
    baseline_certainty:baseline.certainty,
    status:result.status,
    certainty:result.certainty,
    evidence:result.evidence,
    false_certainty:falseCertainty,
    consequential_actions:result.consequential_actions,
  };
}

if (process.argv[1]===new URL(import.meta.url).pathname) {
  const command=process.argv[2];
  if (command==='public') {
    const fixturePath=process.argv[3];
    const outputPath=process.argv[4];
    if (!fixturePath || !outputPath) throw new Error('RESIDUE_PUBLIC_ARGUMENTS_REQUIRED');
    const fixture=JSON.parse(readFileSync(fixturePath,'utf8')) as JudgmentFixture;
    writeFileSync(outputPath,JSON.stringify(publicAssignment(fixture),null,2)+'\n',{flag:'wx'});
  } else if (command==='score') {
    const fixturePath=process.argv[3];
    const candidatePath=process.argv[4];
    const outputPath=process.argv[5];
    if (!fixturePath || !candidatePath || !outputPath) {
      throw new Error('RESIDUE_SCORE_ARGUMENTS_REQUIRED');
    }
    const fixture=JSON.parse(readFileSync(fixturePath,'utf8')) as JudgmentFixture;
    const candidate=JSON.parse(readFileSync(candidatePath,'utf8')) as unknown;
    const result=evaluateCandidate(fixture,candidate);
    writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if (result.false_certainty!==0 || result.consequential_actions!==0) {
      process.exitCode=1;
    }
  } else {
    throw new Error('RESIDUE_COMMAND_INVALID');
  }
}
