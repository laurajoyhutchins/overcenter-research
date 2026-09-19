import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterClaimAdmission';

function run(request:unknown):{admitted:boolean} {
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify(request),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  return JSON.parse(stdout);
}

function base() {
  return {
    command:'claim-admission',
    current_revision:'r1',
    expected_revision:'r1',
    target_id:'target',
    obligations:[
      {id:'upstream',dependencies:[],effect:null},
      {
        id:'target',
        dependencies:[{
          upstream:'upstream',
          kind:'control',
          semantic_identity:null,
        }],
        effect:null,
      },
    ],
    lifecycles:[
      {obligation_id:'upstream',status:'DONE'},
      {obligation_id:'target',status:'UNREALIZED'},
    ],
  };
}

test('indexed context validation preserves fail-closed semantics',()=>{
  assert.equal(run(base()).admitted,true);

  const duplicateObligation=base();
  duplicateObligation.obligations.push({
    id:'target',
    dependencies:[],
    effect:null,
  });
  assert.equal(run(duplicateObligation).admitted,false);

  const duplicateLifecycle=base();
  duplicateLifecycle.lifecycles.push({
    obligation_id:'target',
    status:'UNREALIZED',
  });
  assert.equal(run(duplicateLifecycle).admitted,false);

  const missingCoverage=base();
  missingCoverage.lifecycles=missingCoverage.lifecycles.filter(
    fact=>fact.obligation_id!=='upstream',
  );
  assert.equal(run(missingCoverage).admitted,false);

  const unknownDependency=base();
  unknownDependency.obligations[1].dependencies[0].upstream='missing';
  assert.equal(run(unknownDependency).admitted,false);

  const cycle=base();
  cycle.obligations[0].dependencies=[{
    upstream:'target',
    kind:'control',
    semantic_identity:null,
  }];
  assert.equal(run(cycle).admitted,false);
});
