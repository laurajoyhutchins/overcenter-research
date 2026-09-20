import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import {
  LEGACY_EFFECT_RESERVATION_SCHEMA,
  LEGACY_OBLIGATION_SCHEMA,
} from '../../src/facts.ts';

function git(repo:string,args:string[],input?:string):string {
  return execFileSync('git',['-C',repo,...args],{
    encoding:'utf8',
    input,
    env:{
      ...process.env,
      GIT_AUTHOR_NAME:'Overcenter Test',
      GIT_AUTHOR_EMAIL:'test@local',
      GIT_COMMITTER_NAME:'Overcenter Test',
      GIT_COMMITTER_EMAIL:'test@local',
    },
  }).trim();
}

function appendLegacyObligation(
  repo:string,
  parent:string,
  obligation:Record<string,unknown>,
):string {
  const json=JSON.stringify({
    schema:LEGACY_OBLIGATION_SCHEMA,
    kind:'defined',
    obligation,
  },null,2)+'\n';
  const blob=git(repo,['hash-object','-w','--stdin'],json);
  const tree=git(repo,['mktree'],`100644 blob ${blob}\tobligation.json\n`);
  const commit=git(repo,['commit-tree',tree,'-p',parent],'legacy obligation fixture\n');
  git(repo,['update-ref','refs/overcenter/state',commit,parent]);
  return commit;
}

function appendLegacyReservation(
  repo:string,
  parent:string,
  fact:Record<string,unknown>,
):string {
  const json=JSON.stringify(fact,null,2)+'\n';
  const blob=git(repo,['hash-object','-w','--stdin'],json);
  const tree=git(repo,['mktree'],`100644 blob ${blob}\teffect-reservation.json\n`);
  const commit=git(repo,['commit-tree',tree,'-p',parent],'legacy reservation fixture\n');
  git(repo,['update-ref','refs/overcenter/state',commit,parent]);
  return commit;
}

test('modern obligation rejects a forged legacy v1 reservation', () => {
  const root=mkdtempSync(join(tmpdir(),'overcenter-modern-legacy-reservation-'));
  const authority=join(root,'authority.git');
  const readModel=join(root,'read-model.txt');

  try {
    execFileSync('git',['init','--bare',authority],{stdio:'ignore'});
    const kernel=new GitOvercenterKernel(authority);
    kernel.initialize();
    kernel.define({
      id:'modern-observe-only',
      postcondition:{
        verifier:'eventually-consistent-file-content-equals/v1',
        path:readModel,
        content:'created',
      },
    });
    const ready=kernel.deriveReadyWork()!;
    const run=kernel.claim(ready.id,ready.revision);
    appendLegacyReservation(authority,run.claim_commit,{
      schema:LEGACY_EFFECT_RESERVATION_SCHEMA,
      run_id:run.id,
      obligation_id:run.obligation_id,
      execution_generation:run.execution_generation,
      execution_authority_commit:run.execution_authority_commit,
    });

    assert.throws(
      ()=>kernel.inspect(),
      /LEGACY_EFFECT_RESERVATION_FOR_MODERN_OBLIGATION/,
    );
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('eventually consistent negative readback cannot authorize replay after an uncertain effect', () => {
  const root=mkdtempSync(join(tmpdir(),'overcenter-eventual-readback-'));
  const authority=join(root,'authority.git');
  const providerTruth=join(root,'provider-authoritative-write-log.json');
  const readModel=join(root,'eventually-consistent-read-model.txt');

  try {
    execFileSync('git',['init','--bare',authority],{stdio:'ignore'});
    const kernel=new GitOvercenterKernel(authority);
    const initialized=kernel.initialize();
    appendLegacyObligation(authority,initialized,{
      id:'hostile-effect',
      dependencies:[],
      packet:{effect:'create-resource',key:'resource-42',value:'created'},
      postcondition:{
        verifier:'eventually-consistent-file-content-equals/v1',
        path:readModel,
        content:'created',
      },
    });

    const ready=kernel.deriveReadyWork()!;
    const run=kernel.claim(ready.id,ready.revision);

    let effectAttempts=0;
    const performProviderEffect=() => {
      effectAttempts+=1;
      writeFileSync(providerTruth,JSON.stringify({
        key:'resource-42',
        value:'created',
        accepted:true,
      }));
    };

    // Preserve the original experiment's historical v1 reservation semantics
    // without reintroducing a production API for arbitrary effect callbacks.
    appendLegacyReservation(authority,run.claim_commit,{
      schema:LEGACY_EFFECT_RESERVATION_SCHEMA,
      run_id:run.id,
      obligation_id:run.obligation_id,
      execution_generation:run.execution_generation,
      execution_authority_commit:run.execution_authority_commit,
    });
    performProviderEffect();
    kernel.recoverInterrupted(run,{source:'hostile-provider-timeout'});

    // First readback is a stale 404 / missing object. Because this provider's
    // read model is eventually consistent, that negative is not authoritative.
    const missing=kernel.reconcile(run);
    assert.equal(missing.disposition,'RECOVERY_REQUIRED');
    assert.equal(missing.observed?.mutation_certainty,'uncertain');
    assert.equal(missing.observed?.absence_evidence,undefined);
    assert.equal(missing.observed?.observation_error,'NEGATIVE_READ_NOT_AUTHORITATIVE');
    assert.equal(kernel.deriveReadyWork(),null);
    assert.equal(kernel.inspect()[0].run_id,run.id);

    // Readback advances, but only to an older value. A non-match is still not
    // proof that the accepted mutation failed to happen.
    writeFileSync(readModel,'old-value');
    const stale=kernel.reconcile(run);
    assert.equal(stale.disposition,'RECOVERY_REQUIRED');
    assert.equal(stale.observed?.mutation_certainty,'uncertain');
    assert.equal(stale.observed?.absence_evidence,undefined);
    assert.equal(stale.observed?.observation_error,'NON_MATCHING_READ_NOT_AUTHORITATIVE');
    assert.equal(kernel.deriveReadyWork(),null);

    // Once the read model converges, the same run settles without replaying.
    writeFileSync(readModel,'created');
    const done=kernel.reconcile(run);
    assert.equal(done.disposition,'DONE');
    assert.equal(done.verified,true);
    assert.equal(done.observed?.mutation_certainty,'present');
    assert.equal(kernel.inspect()[0].status,'DONE');

    assert.equal(effectAttempts,1);
    assert.equal(JSON.parse(readFileSync(providerTruth,'utf8')).accepted,true);
    assert.equal(done.claim_commit,run.claim_commit);
    assert.deepEqual(
      kernel.receipts(run.id).map(receipt=>receipt.disposition),
      ['RECOVERY_REQUIRED','RECOVERY_REQUIRED','RECOVERY_REQUIRED','DONE'],
    );
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
