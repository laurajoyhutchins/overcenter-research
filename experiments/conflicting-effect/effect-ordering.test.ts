import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import { canonicalDigest } from '../../src/digest.ts';
import { githubCommitStatusEffectAuthority } from '../../src/provider-effect.ts';
import type { ObligationInput } from '../../src/facts.ts';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'overcenter-effect-order-'));
  const repo=join(root,'state.git');
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(repo);
  kernel.initialize();
  return {root,repo,kernel};
}

function statusPostcondition(state:'success'|'failure',context='overcenter/conflict') {
  return {
    verifier:'github-commit-status/v1' as const,
    provider:'github' as const,
    repository_id:123,
    commit_sha:'a'.repeat(40),
    context,
    expected_state:state,
  };
}

function statusEffect(
  id:string,
  state:'success'|'failure',
  dependencies:NonNullable<ObligationInput['dependencies']>=[],
  context='overcenter/conflict',
):ObligationInput {
  return {
    id,
    dependencies,
    packet:{kind:'effect-order-proof/v1'},
    postcondition:statusPostcondition(state,context),
    effect_authority:githubCommitStatusEffectAuthority(),
    result_acceptance:{
      verifier:'canonical-json-sha256/v1',
      expected_sha256:canonicalDigest({id,state,context}),
    },
  };
}

test('unordered incompatible canonical effects are rejected before definition commits', () => {
  const f=fixture();
  try {
    f.kernel.define(statusEffect('alpha','success'));
    const acceptedHead=f.kernel.head();

    assert.throws(
      ()=>f.kernel.define(statusEffect('beta','failure')),
      /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
    );

    assert.equal(f.kernel.head(),acceptedHead);
    assert.deepEqual(
      f.kernel.inspect().map(work=>[work.id,work.status]),
      [['alpha','READY']],
    );
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('amendment cannot remove ordering and create a static effect conflict', () => {
  const f=fixture();
  try {
    f.kernel.define(statusEffect('alpha','success'));
    f.kernel.define(statusEffect(
      'beta',
      'failure',
      [{kind:'control',upstream:'alpha'}],
    ));
    const acceptedHead=f.kernel.head()!;

    assert.throws(
      ()=>f.kernel.amend(statusEffect('beta','failure'),acceptedHead),
      /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
    );

    assert.equal(f.kernel.head(),acceptedHead);
    assert.deepEqual(
      f.kernel.inspect().find(work=>work.id==='beta')?.dependencies,
      [{kind:'control',upstream:'alpha'}],
    );
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('explicit graph order permits the canonical conflicting predecessor to be claimed', () => {
  const f=fixture();
  try {
    f.kernel.define(statusEffect('alpha','success'));
    f.kernel.define(statusEffect(
      'beta',
      'failure',
      [{kind:'control',upstream:'alpha'}],
    ));

    const alpha=f.kernel.deriveReadyWork();
    assert.ok(alpha);
    assert.equal(alpha.id,'alpha');
    assert.equal(alpha.status,'READY');

    const run=f.kernel.claim(alpha.id,alpha.revision);
    assert.equal(run.obligation_id,'alpha');

    const beta=f.kernel.inspect().find(work=>work.id==='beta');
    assert.ok(beta);
    assert.equal(beta.status,'BLOCKED');
    assert.equal(beta.blocked_reason,'DEPENDENCIES_NOT_DONE');
    assert.equal(f.kernel.deriveReadyWork(),null);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('GitHub status contexts differing only by case conflict at admission', () => {
  const f=fixture();
  try {
    f.kernel.define(statusEffect(
      'alpha',
      'success',
      [],
      'overcenter/Build',
    ));
    const acceptedHead=f.kernel.head();

    assert.throws(
      ()=>f.kernel.define(statusEffect(
        'beta',
        'failure',
        [],
        'overcenter/build',
      )),
      /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
    );

    assert.equal(f.kernel.head(),acceptedHead);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('github status adapter explicitly allows identical desired state to commute', () => {
  const f=fixture();
  try {
    f.kernel.define(statusEffect('alpha','success'));
    f.kernel.define(statusEffect('beta','success'));

    const alpha=f.kernel.deriveReadyWork();
    assert.ok(alpha);
    const runA=f.kernel.claim(alpha.id,alpha.revision);

    const beta=f.kernel.deriveReadyWork();
    assert.ok(beta);
    assert.equal(beta.id,'beta');
    const runB=f.kernel.claim(beta.id,beta.revision);

    assert.notEqual(runA.id,runB.id);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('noncanonical proof adapters do not claim generic mutation-domain semantics', () => {
  const f=fixture();
  try {
    f.kernel.define({
      id:'alpha',
      postcondition:{verifier:'file-content-equals/v1',path:'/tmp/alias-a',content:'same'},
    });
    f.kernel.define({
      id:'beta',
      postcondition:{verifier:'file-content-equals/v1',path:'/tmp/alias-a',content:'different'},
    });

    const alpha=f.kernel.deriveReadyWork();
    assert.ok(alpha);
    assert.equal(alpha.id,'alpha');
    assert.equal(alpha.status,'READY');
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});
