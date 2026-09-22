#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {evaluate} from '../recovery-agent-search/score.mjs';

const forbiddenKeys=new Set([
  'certainty',
  'effect_digest',
  'expected_effect_digest',
  'matched_record',
  'outcome',
  'reason',
  'resolved',
]);

function cardinalityOf(item) {
  const result=item.agent.result;
  if (result.resolved || result.reason==='EFFECT_BINDING_MISMATCH') return 'one';
  if (result.reason==='NO_AUTHORITATIVE_MATCH') return 'zero';
  if (result.reason==='AMBIGUOUS_AUTHORITATIVE_MATCH') return 'many';
  if (result.reason==='NO_SEARCH_PROPOSAL') return 'not-searched';
  throw new Error(`UNEXPECTED_SEARCH_RESULT:${result.reason}`);
}

function assertSanitized(value) {
  const visit=node=>{
    if (!node || typeof node!=='object') return;
    for (const [key,child] of Object.entries(node)) {
      if (forbiddenKeys.has(key)) throw new Error(`OBSERVATION_LEAK:${key}`);
      visit(child);
    }
  };
  visit(value);
}

export function observe(candidate) {
  const evaluated=evaluate(candidate);
  const rejectedByCase=new Set(
    evaluated.rejected_agent_proposals
      .map(item=>item.case_id)
      .filter(value=>typeof value==='string'),
  );
  const observations=evaluated.cases.map(item=>({
    case_id:item.id,
    previous_proposal:item.agent.proposal,
    cardinality:rejectedByCase.has(item.id) ? 'not-searched' : cardinalityOf(item),
  }));
  const output={
    schema:'overcenter-recovery-search-observations/v1',
    observations,
  };
  assertSanitized(output);
  return output;
}

if (process.argv[1]===new URL(import.meta.url).pathname) {
  const candidatePath=process.argv[2];
  const outputPath=process.argv[3];
  if (!candidatePath || !outputPath) throw new Error('USAGE: observe.mjs <candidate.json> <observations.json>');
  const candidate=JSON.parse(readFileSync(candidatePath,'utf8'));
  writeFileSync(outputPath,JSON.stringify(observe(candidate),null,2)+'\n',{flag:'wx'});
}
