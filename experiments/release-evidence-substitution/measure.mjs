import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path='experiments/release-evidence-substitution/safe-paths.mjs';
const source=readFileSync(path,'utf8');

function block(name) {
  const start=`// measure:${name}:start`;
  const end=`// measure:${name}:end`;
  const a=source.indexOf(start);
  const b=source.indexOf(end);
  if(a<0 || b<0 || b<=a) throw new Error(`measurement markers missing: ${name}`);
  return source.slice(a+start.length,b);
}

function codeLines(text) {
  return text.split('\n')
    .map(line=>line.trim())
    .filter(line=>line && !line.startsWith('//'))
    .length;
}

function markerCount(text,marker) {
  return text.split('\n').filter(line=>line.includes(`// ${marker}`)).length;
}

const conventional=block('conventional');
const overcenter=block('overcenter');
const framework=readFileSync('src/providers/kubernetes-deployment.ts','utf8');

const result={
  application_correctness_loc:{
    conventional:codeLines(conventional),
    overcenter:codeLines(overcenter),
  },
  application_authored_identity_joins:{
    conventional:markerCount(conventional,'identity-join'),
    overcenter:markerCount(overcenter,'identity-join'),
  },
  application_owned_recovery_branches:{
    conventional:markerCount(conventional,'recovery-branch'),
    overcenter:markerCount(overcenter,'recovery-branch'),
  },
  reusable_framework_loc:{
    conventional:0,
    overcenter:codeLines(framework),
  },
};

assert.ok(
  result.application_correctness_loc.overcenter
    <= result.application_correctness_loc.conventional/4,
  'Overcenter application correctness path must be at least 4x smaller',
);
assert.ok(
  result.application_authored_identity_joins.conventional>0
  && result.application_authored_identity_joins.overcenter===0,
  'identity joins must move out of application code',
);
assert.ok(
  result.application_owned_recovery_branches.conventional>0
  && result.application_owned_recovery_branches.overcenter===0,
  'recovery branches must move out of application code',
);

console.log(JSON.stringify(result,null,2));
