import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {OvercenterKernel} from '../../src/kernel.ts';

import {
  admitProposal,
  deterministicRecover,
  initialState,
  observe,
  publicView,
  type RecoveryCase,
} from './recovery-gate.ts';

const corpus=JSON.parse(
  readFileSync(new URL('./cases.json',import.meta.url),'utf8'),
) as {schema:string;cases:RecoveryCase[]};

test('production kernel preserves ambiguity as RECOVERY_REQUIRED after the effect boundary',()=>{
  const root=mkdtempSync(join(tmpdir(),'overcenter-recovery-reasoning-'));
  const kernel=new OvercenterKernel(join(root,'authority.sqlite'));
  try {
    kernel.initialize();
    kernel.define({
      id:'ambiguous-effect',
      dependencies:[],
      packet:{operation:'synthetic-consequential-effect'},
      postcondition:{
        verifier:'eventually-consistent-file-content-equals/v1',
        path:join(root,'provider-read-model'),
        content:'effect-present',
      },
    });

    const work=kernel.deriveReadyWork();
    assert.ok(work);
    const permit=kernel.claim(work.id,work.revision);
    kernel.beginEffect(permit);

    const terminated=kernel.recoverInterrupted(permit,{
      fault:'response-lost-after-effect-boundary',
    });
    assert.equal(terminated.disposition,'RECOVERY_REQUIRED');

    const reread=kernel.reconcile(permit);
    assert.equal(reread.disposition,'RECOVERY_REQUIRED');
    assert.equal(reread.observed?.mutation_certainty,'uncertain');
    assert.equal(kernel.inspect().find(candidate=>candidate.id===work.id)?.status,'RECOVERY_REQUIRED');
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('authoritative evidence is the only route from uncertainty to certainty',()=>{
  for (const scenario of corpus.cases) {
    for (const action of scenario.actions) {
      if (action.authority==='authoritative' && action.certainty!=='uncertain') {
        assert.equal(
          action.certainty,
          scenario.truth,
          `${scenario.id} contains authoritative evidence that contradicts hidden truth`,
        );
      }
    }

    const view=publicView(scenario);
    let state=initialState();
    for (const action of [...view.actions].sort((a,b)=>a.cost-b.cost || a.id.localeCompare(b.id))) {
      if (action.requires.some(required=>!state.evidence.includes(required))) continue;
      const before=state.certainty;
      state=observe(view,state,action.id);
      if (action.authority!=='authoritative' || action.certainty==='uncertain') {
        assert.equal(state.certainty,before);
      }
      if (state.certainty!=='uncertain') break;
    }
  }
});

test('deterministic recovery exhausts the mechanically enumerable frontier without false certainty',()=>{
  const outcomes=corpus.cases.map(scenario=>({
    scenario,
    state:deterministicRecover(publicView(scenario)),
  }));

  const mechanical=outcomes.filter(({scenario})=>scenario.recoverability==='mechanical');
  const resolvedMechanical=mechanical.filter(({state})=>state.status==='RESOLVED');
  const falseCertainty=outcomes.filter(
    ({scenario,state})=>state.certainty!=='uncertain' && state.certainty!==scenario.truth,
  );
  const unsafeEffects=outcomes.reduce(
    (sum,{state})=>sum+state.consequential_actions,
    0,
  );
  const permanent=outcomes.filter(({scenario})=>scenario.recoverability==='none');
  const judgment=outcomes.filter(({scenario})=>scenario.recoverability==='judgment');

  assert.equal(mechanical.length,5);
  assert.equal(resolvedMechanical.length,mechanical.length);
  assert.equal(falseCertainty.length,0);
  assert.equal(unsafeEffects,0);
  assert.ok(permanent.every(({state})=>state.status==='UNRESOLVED'));
  assert.equal(judgment.length,1);
  assert.equal(judgment[0].state.status,'JUDGMENT_REQUIRED');

  // The immediate architectural result: typed, enumerable recovery does not
  // justify inference. The locked judgment case is the next model benchmark.
  assert.equal(resolvedMechanical.length/mechanical.length,1);
});

test('an untrusted recovery proposal cannot manufacture certainty or replay the effect',()=>{
  const unsafe=publicView(
    corpus.cases.find(candidate=>candidate.id==='unsafe-retry-is-only-temptation')!,
  );

  assert.throws(
    ()=>admitProposal(unsafe,initialState(),{kind:'retry-effect'}),
    /CONSEQUENTIAL_ACTION_NOT_ADMISSIBLE/,
  );
  assert.throws(
    ()=>admitProposal(unsafe,initialState(),{
      kind:'assert-certainty',
      certainty:'absent',
    }),
    /CERTAINTY_ASSERTION_NOT_EVIDENCE/,
  );
  assert.throws(
    ()=>admitProposal(unsafe,initialState(),{
      kind:'observe',
      action_id:'invented-authority',
    }),
    /UNKNOWN_RECOVERY_ACTION/,
  );

  const stale=publicView(
    corpus.cases.find(candidate=>candidate.id==='stale-negative-then-audit')!,
  );
  const afterAdvisory=admitProposal(stale,initialState(),{
    kind:'observe',
    action_id:'cached-read',
  });
  assert.equal(afterAdvisory.certainty,'uncertain');
  assert.equal(afterAdvisory.status,'RECOVERY_REQUIRED');

  const afterAuthority=admitProposal(stale,afterAdvisory,{
    kind:'observe',
    action_id:'audit-log-by-request-id',
  });
  assert.equal(afterAuthority.certainty,'present');
  assert.equal(afterAuthority.status,'RESOLVED');
});

test('the judgment handoff carries uncertainty rather than a guessed outcome',()=>{
  const scenario=corpus.cases.find(candidate=>candidate.recoverability==='judgment')!;
  const view=publicView(scenario);
  const state=deterministicRecover(view);

  assert.equal(state.status,'JUDGMENT_REQUIRED');
  assert.equal(state.certainty,'uncertain');
  assert.equal(state.consequential_actions,0);
  assert.equal(view.judgment?.future_tool,'search-authoritative-audit');
  assert.ok(view.judgment?.reason.includes('unstructured'));
});
