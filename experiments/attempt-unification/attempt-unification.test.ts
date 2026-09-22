import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import test from 'node:test';
import {
  acquireExecutionLegacy,
  beginEffectLegacy,
  claimLegacy,
  initialLegacy,
  interruptLegacy,
  proveContainmentTerminatedLegacy,
  settleAbsentLegacy,
  settlePresentLegacy,
} from './legacy-model.ts';
import {
  beginEffectUnsafe,
  claimUnsafe,
  initialUnsafe,
  interruptUnsafe,
  mayExecuteUnsafe,
  recoverUnsafe,
} from './unsafe-model.ts';
import {
  authorityAcceptedUnsafeEffectClock,
  beginEffectUnsafeEffectClock,
  claimUnsafeEffectClock,
  initialUnsafeEffectClock,
  interruptUnsafeEffectClock,
  recoverUnsafeEffectClock,
} from './unsafe-effect-clock-model.ts';
import {
  assertMayExecuteCandidate,
  beginEffectAttempt,
  beginRecoveryAttempt,
  claimCandidate,
  initialCandidate,
  interruptCandidate,
  proveContainmentTerminatedCandidate,
  settleAbsentCandidate,
  settlePresentCandidate,
} from './candidate-model.ts';

function sloc(path:string):number {
  return readFileSync(new URL(path,import.meta.url),'utf8')
    .split(/\r?\n/u)
    .filter(line=>line.trim() && !line.trim().startsWith('//')).length;
}

function median(values:number[]):number {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length/2)]!;
}

function bench(iterations:number,fn:()=>void):number {
  const start=performance.now();
  for (let i=0;i<iterations;i+=1) fn();
  return performance.now()-start;
}

test('candidate preserves stale-authority fencing during external recovery',()=>{
  const legacy=initialLegacy('effect');
  const legacyFirst=claimLegacy(legacy);
  beginEffectLegacy(legacy,legacyFirst);
  interruptLegacy(legacy,legacyFirst);
  const legacyRecovery=acquireExecutionLegacy(legacy);
  assert.throws(()=>settlePresentLegacy(legacy,legacyFirst),/STALE_EXECUTION_GENERATION/);
  settlePresentLegacy(legacy,legacyRecovery);
  assert.equal(legacy.receipt,'done');

  const candidate=initialCandidate('effect');
  assert.equal(claimCandidate(candidate),null);
  const candidateFirst=beginEffectAttempt(candidate);
  interruptCandidate(candidate,candidateFirst);
  const candidateRecovery=beginRecoveryAttempt(candidate);
  assert.equal(candidateRecovery.purpose,'recover');
  assert.throws(()=>settlePresentCandidate(candidate,candidateFirst),/STALE_ATTEMPT/);
  settlePresentCandidate(candidate,candidateRecovery);
  assert.equal(candidate.receipt,'done');
});

test('recovery authority cannot become a second external effect',()=>{
  const candidate=initialCandidate('effect');
  claimCandidate(candidate);
  const first=beginEffectAttempt(candidate);
  assertMayExecuteCandidate(candidate,first);
  interruptCandidate(candidate,first);
  const recovery=beginRecoveryAttempt(candidate);
  assert.throws(()=>assertMayExecuteCandidate(candidate,recovery),/RECOVERY_ATTEMPT_CANNOT_EXECUTE/);
  assert.throws(()=>beginEffectAttempt(candidate),/NOT_EFFECT_READY|UNRESOLVED_EFFECT/);
});

test('authoritative absence closes the external attempt without blind replay',()=>{
  const legacy=initialLegacy('effect');
  const l1=claimLegacy(legacy);
  beginEffectLegacy(legacy,l1);
  interruptLegacy(legacy,l1);
  const lr=acquireExecutionLegacy(legacy);
  settleAbsentLegacy(legacy,lr);
  assert.equal(legacy.receipt,'ready');
  assert.equal(legacy.unresolvedEffect,false);

  const candidate=initialCandidate('effect');
  claimCandidate(candidate);
  const c1=beginEffectAttempt(candidate);
  interruptCandidate(candidate,c1);
  const cr=beginRecoveryAttempt(candidate);
  settleAbsentCandidate(candidate,cr);
  assert.equal(candidate.receipt,'ready');
  assert.equal(candidate.unresolvedEffectAttempt,null);
});

test('computation retry still requires proof that the old containment domain is gone',()=>{
  const legacy=initialLegacy('computation');
  const l1=claimLegacy(legacy);
  interruptLegacy(legacy,l1);
  assert.throws(()=>acquireExecutionLegacy(legacy),/CONTAINMENT_TERMINATION_UNPROVEN/);
  proveContainmentTerminatedLegacy(legacy);
  const l2=acquireExecutionLegacy(legacy);
  settlePresentLegacy(legacy,l2);

  const candidate=initialCandidate('computation');
  const c1=claimCandidate(candidate)!;
  interruptCandidate(candidate,c1);
  assert.throws(()=>beginRecoveryAttempt(candidate),/CONTAINMENT_TERMINATION_UNPROVEN/);
  proveContainmentTerminatedCandidate(candidate);
  const c2=beginRecoveryAttempt(candidate);
  assert.equal(c2.purpose,'execute');
  settlePresentCandidate(candidate,c2);
});

test('durable write amplification is never worse in representative transactions',()=>{
  const rows:Array<[string,number,number]>=[];
  {
    const legacy=initialLegacy('computation');
    const lp=claimLegacy(legacy);
    settlePresentLegacy(legacy,lp);
    const candidate=initialCandidate('computation');
    const cp=claimCandidate(candidate)!;
    settlePresentCandidate(candidate,cp);
    rows.push(['computation success',legacy.writes,candidate.writes]);
  }
  {
    const legacy=initialLegacy('effect');
    const lp=claimLegacy(legacy); beginEffectLegacy(legacy,lp); settlePresentLegacy(legacy,lp);
    const candidate=initialCandidate('effect');
    claimCandidate(candidate); const cp=beginEffectAttempt(candidate); settlePresentCandidate(candidate,cp);
    rows.push(['effect success',legacy.writes,candidate.writes]);
  }
  {
    const legacy=initialLegacy('computation');
    const l1=claimLegacy(legacy); interruptLegacy(legacy,l1); proveContainmentTerminatedLegacy(legacy);
    const l2=acquireExecutionLegacy(legacy); settlePresentLegacy(legacy,l2);
    const candidate=initialCandidate('computation');
    const c1=claimCandidate(candidate)!; interruptCandidate(candidate,c1); proveContainmentTerminatedCandidate(candidate);
    const c2=beginRecoveryAttempt(candidate); settlePresentCandidate(candidate,c2);
    rows.push(['computation recovery',legacy.writes,candidate.writes]);
  }
  {
    const legacy=initialLegacy('effect');
    const l1=claimLegacy(legacy); beginEffectLegacy(legacy,l1); interruptLegacy(legacy,l1);
    const lr=acquireExecutionLegacy(legacy); settlePresentLegacy(legacy,lr);
    const candidate=initialCandidate('effect');
    claimCandidate(candidate); const c1=beginEffectAttempt(candidate); interruptCandidate(candidate,c1);
    const cr=beginRecoveryAttempt(candidate); settlePresentCandidate(candidate,cr);
    rows.push(['effect recovery',legacy.writes,candidate.writes]);
  }
  for (const [name,legacyWrites,candidateWrites] of rows) {
    assert.ok(candidateWrites<=legacyWrites,`${name}: ${candidateWrites} > ${legacyWrites}`);
  }
  assert.deepEqual(rows,[
    ['computation success',2,2],
    ['effect success',3,3],
    ['computation recovery',4,4],
    ['effect recovery',5,5],
  ]);
});

test('safe two-concept collapse does not reduce the bounded authority slice',()=>{
  const legacy=sloc('./legacy-model.ts');
  const candidate=sloc('./candidate-model.ts');
  const unsafe=sloc('./unsafe-model.ts');
  assert.ok(candidate>=legacy,`safe candidate unexpectedly shrank: ${candidate} < ${legacy}`);
  assert.ok(unsafe<candidate,'negative control must demonstrate why deleting the recovery-purpose state looks attractive');
  console.log(JSON.stringify({
    metric:'authority-model-sloc',
    legacy,
    safe_candidate:candidate,
    unsafe_candidate:unsafe,
    safe_delta:(candidate-legacy)/legacy,
  }));
});

test('the smaller naive collapse permits a duplicate external effect after recovery fencing',()=>{
  const state=initialUnsafe();
  const first=claimUnsafe(state);
  beginEffectUnsafe(state,first);
  interruptUnsafe(state,first);
  const recovery=recoverUnsafe(state);
  assert.equal(state.unresolvedEffect,true);
  assert.equal(mayExecuteUnsafe(state,recovery),true);
});

test('a single clock that preserves the mutation epoch cannot fence the stale worker',()=>{
  const state=initialUnsafeEffectClock();
  const first=claimUnsafeEffectClock(state);
  beginEffectUnsafeEffectClock(state,first);
  interruptUnsafeEffectClock(state,first);
  const recovery=recoverUnsafeEffectClock(state);
  assert.equal(recovery,first);
  assert.equal(state.unresolvedEffect,true);
  assert.equal(authorityAcceptedUnsafeEffectClock(state,first),true);
});

test('candidate transition throughput remains within the pre-registered 1.25x bound',()=>{
  const iterations=200_000;
  const legacySamples:number[]=[];
  const candidateSamples:number[]=[];
  for (let round=0;round<7;round+=1) {
    legacySamples.push(bench(iterations,()=>{
      const state=initialLegacy('effect');
      const first=claimLegacy(state);
      beginEffectLegacy(state,first);
      interruptLegacy(state,first);
      const recovery=acquireExecutionLegacy(state);
      settlePresentLegacy(state,recovery);
    }));
    candidateSamples.push(bench(iterations,()=>{
      const state=initialCandidate('effect');
      claimCandidate(state);
      const first=beginEffectAttempt(state);
      interruptCandidate(state,first);
      const recovery=beginRecoveryAttempt(state);
      settlePresentCandidate(state,recovery);
    }));
  }
  const legacyMs=median(legacySamples);
  const candidateMs=median(candidateSamples);
  const ratio=candidateMs/legacyMs;
  console.log(JSON.stringify({metric:'effect-recovery-throughput',iterations,legacy_ms:legacyMs,candidate_ms:candidateMs,ratio}));
  assert.ok(ratio<=1.25,`candidate is ${ratio.toFixed(2)}x legacy; limit is 1.25x`);
});
