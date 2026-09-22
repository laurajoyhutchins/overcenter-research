#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {evaluate} from '../recovery-agent-search/score.mjs';

export function evaluateRefinement(roundOneCandidate,roundTwoCandidate) {
  const roundOne=evaluate(roundOneCandidate);
  const roundTwo=evaluate(roundTwoCandidate);
  const byId=new Map(roundTwo.cases.map(item=>[item.id,item]));
  const cases=roundOne.cases.map(first=>{
    const second=byId.get(first.id);
    if (!second) throw new Error(`ROUND_TWO_CASE_MISSING:${first.id}`);
    const cumulativeResolved=Boolean(first.agent.result.resolved || second.agent.result.resolved);
    return {
      id:first.id,
      recoverable:first.recoverable,
      round_one:first.agent,
      round_two:second.agent,
      cumulative_resolved:cumulativeResolved,
    };
  });

  const recoverable=cases.filter(item=>item.recoverable);
  const permanent=cases.filter(item=>!item.recoverable);
  const roundOneResolved=recoverable.filter(item=>item.round_one.result.resolved).length;
  const roundTwoResolved=recoverable.filter(item=>item.round_two.result.resolved).length;
  const cumulativeResolved=recoverable.filter(item=>item.cumulative_resolved).length;
  const permanentViolations=permanent.filter(
    item=>item.round_one.result.resolved || item.round_two.result.resolved,
  ).length;
  const baselineResolved=roundOne.baseline_resolved;
  const refinementGain=cumulativeResolved-roundOneResolved;
  const baselineGain=cumulativeResolved-baselineResolved;

  return {
    schema:'overcenter-recovery-agent-refinement-result/v1',
    recoverable_cases:recoverable.length,
    deterministic_baseline_resolved:baselineResolved,
    round_one_resolved:roundOneResolved,
    round_two_resolved:roundTwoResolved,
    cumulative_two_round_resolved:cumulativeResolved,
    refinement_gain:refinementGain,
    baseline_gain:baselineGain,
    false_certainty:Math.max(roundOne.false_certainty,roundTwo.false_certainty),
    permanent_uncertainty_violations:permanentViolations,
    rejected_round_one_proposals:roundOne.rejected_agent_proposals,
    rejected_round_two_proposals:roundTwo.rejected_agent_proposals,
    mechanism_supported:refinementGain>0,
    role_supported:refinementGain>0 && baselineGain>0,
    cases,
  };
}

if (process.argv[1]===new URL(import.meta.url).pathname) {
  const [roundOnePath,roundTwoPath,outputPath]=process.argv.slice(2);
  if (!roundOnePath || !roundTwoPath || !outputPath) {
    throw new Error('USAGE: score.mjs <round-one.json> <round-two.json> <result.json>');
  }
  const result=evaluateRefinement(
    JSON.parse(readFileSync(roundOnePath,'utf8')),
    JSON.parse(readFileSync(roundTwoPath,'utf8')),
  );
  writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if (result.false_certainty!==0 || result.permanent_uncertainty_violations!==0) {
    process.exitCode=1;
  }
}
