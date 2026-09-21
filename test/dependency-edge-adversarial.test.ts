import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  controlDependency,
  GitKernelFixture,
  verifiedContent,
} from './support/git-kernel-fixture.ts';

function withFixture(name:string,body:(f:GitKernelFixture)=>void) {
  test(name,()=>{
    const f=new GitKernelFixture('overcenter-edge-adversarial-');
    try {
      body(f);
    } finally {
      f.close();
    }
  });
}


withFixture('control dependency changes executability but does not poison downstream semantic identity',f=>{
  f.defineFile('a',{content:'A1'});
  f.defineFile('b',{content:'B',dependencies:[controlDependency('a')]});

  f.settleFile('a');
  f.settleFile('b');
  const before=f.work('b');

  f.rebindFile('a',{content:'A2'});
  const after=f.work('b');

  assert.equal(after.status,'DONE');
  assert.equal(after.run_id,before.run_id);
});

withFixture('semantic dependency invalidates downstream when consumed output identity changes',f=>{
  f.defineFile('a',{content:'A1'});
  f.defineFile('b',{content:'B',dependencies:[verifiedContent('a')]});

  f.settleFile('a');
  f.settleFile('b');

  f.rebindFile('a',{content:'A2'});
  f.settleFile('a');

  assert.equal(f.work('b').status,'READY');
});

withFixture('semantic dependency does not invalidate downstream when selected output identity is unchanged',f=>{
  f.defineFile('a',{content:'same-output',packet:{producer:'v1'}});
  f.defineFile('b',{content:'B',dependencies:[verifiedContent('a')]});

  f.settleFile('a');
  f.settleFile('b');
  const before=f.work('b');

  f.rebindFile('a',{content:'same-output',packet:{producer:'v2'}});
  f.settleFile('a');
  const after=f.work('b');

  assert.equal(after.status,'DONE');
  assert.equal(after.run_id,before.run_id);
});

withFixture('invalidation propagation stops when an intermediary exposes the same selected identity',f=>{
  f.defineFile('a',{content:'same-a-output',packet:{producer:'v1'}});
  f.defineFile('b',{content:'stable-b-output',dependencies:[verifiedContent('a')]});
  f.defineFile('c',{content:'C',dependencies:[verifiedContent('b')]});

  f.settleFile('a');
  f.settleFile('b');
  f.settleFile('c');
  const before=f.work('c');

  f.rebindFile('a',{content:'same-a-output',packet:{producer:'v2'}});
  f.settleFile('a');

  assert.equal(f.work('b').status,'DONE');
  assert.equal(f.work('c').status,'DONE');
  assert.equal(f.work('c').run_id,before.run_id);
});

withFixture('claim fact durably binds the exact semantic obligation key',f=>{
  f.defineFile('a',{content:'A'});
  f.defineFile('b',{content:'B',dependencies:[verifiedContent('a')]});
  f.settleFile('a');

  const run=f.claim('b');
  const claim=JSON.parse(f.git(['show',`${run.claim_commit}:claim.json`])) as {
    schema?:string;
    obligation_key?:string;
    claimed_revision?:string;
  };

  assert.equal(claim.schema,'overcenter-git-claim-v3');
  assert.equal(claim.obligation_key,run.obligation_key);
  assert.match(claim.obligation_key!,/^[0-9a-f]{64}$/);
  assert.equal(claim.claimed_revision,run.claimed_revision);
});

withFixture('semantic selector is part of durable edge meaning',f=>{
  f.defineFile('a',{content:'A'});
  const bDefinition=f.defineFile('b',{
    content:'B',
    dependencies:[{
      kind:'semantic',
      upstream:'a',
      consumes:{kind:'evidence',selector:'settlement-receipt'},
    }],
  });

  const fact=obligationFact(f,bDefinition);
  assert.equal(fact.schema,'overcenter-git-obligation-v3');
  assert.equal('deps' in fact.obligation,false);
  assert.deepEqual(
    (fact.obligation as {dependencies?:unknown}).dependencies,
    [{
      kind:'semantic',
      upstream:'a',
      consumes:{kind:'evidence',selector:'settlement-receipt'},
    }],
  );
});

withFixture('reclassifying control dependency as semantic cannot reuse old completion silently',f=>{
  f.defineFile('a',{content:'A'});
  f.defineFile('b',{content:'B',dependencies:[controlDependency('a')]});
  f.settleFile('a');
  f.settleFile('b');

  const dependencies=[{
    kind:'semantic' as const,
    upstream:'a',
    consumes:{kind:'evidence' as const,selector:'settlement-receipt'},
  }];
  const amended=f.rebindFile('b',{content:'B',dependencies});
  const fact=obligationFact(f,amended);

  assert.deepEqual(
    (fact.obligation as {dependencies?:unknown}).dependencies,
    dependencies,
  );
  assert.equal(f.work('b').status,'READY');
});

withFixture('rewiring a satisfied control edge does not change downstream semantic identity',f=>{
  f.defineFile('a',{content:'A'});
  f.defineFile('c',{content:'C'});
  f.defineFile('b',{content:'B',dependencies:[controlDependency('a')]});
  f.settleFile('a');
  f.settleFile('c');
  f.settleFile('b');
  const before=f.work('b');

  f.rebindFile('b',{content:'B',dependencies:[controlDependency('c')]});
  const after=f.work('b');

  assert.equal(after.status,'DONE');
  assert.equal(after.run_id,before.run_id);
});

withFixture('content-selected semantic dependency can reuse across equivalent producers',f=>{
  f.defineFile('a',{content:'same-content'});
  f.defineFile('c',{content:'same-content'});
  f.defineFile('b',{content:'B',dependencies:[verifiedContent('a')]});
  f.settleFile('a');
  f.settleFile('c');
  f.settleFile('b');
  const before=f.work('b');

  f.rebindFile('b',{content:'B',dependencies:[verifiedContent('c')]});
  const after=f.work('b');

  assert.equal(after.status,'DONE');
  assert.equal(after.run_id,before.run_id);
});

withFixture('unsupported semantic selector is rejected before any definition fact is committed',f=>{
  f.defineFile('a',{content:'A'});
  const acceptedHead=f.kernel.head();

  assert.throws(
    ()=>f.defineFile('b',{
      content:'B',
      dependencies:[{
        kind:'semantic',
        upstream:'a',
        consumes:{kind:'output',selector:'ambient-file'},
      }],
    }),
    /UNSUPPORTED_SEMANTIC_SELECTOR:output:ambient-file/,
  );

  assert.equal(f.kernel.head(),acceptedHead);
  assert.equal(f.kernel.inspect().some(work=>work.id==='b'),false);
});

withFixture('semantic edge declaration order does not change obligation identity',f=>{
  f.defineFile('a',{content:'A'});
  f.defineFile('c',{content:'C'});
  f.defineFile('b',{
    content:'B',
    dependencies:[verifiedContent('a'),verifiedContent('c')],
  });
  f.settleFile('a');
  f.settleFile('c');
  f.settleFile('b');
  const before=f.work('b');

  f.rebindFile('b',{
    content:'B',
    dependencies:[verifiedContent('c'),verifiedContent('a')],
  });
  const after=f.work('b');

  assert.equal(after.status,'DONE');
  assert.equal(after.run_id,before.run_id);
});

withFixture('undeclared hidden dependency remains outside the derivation model',f=>{
  f.defineFile('x',{content:'declared'});
  f.settleFile('x');

  const before=JSON.stringify(f.kernel.inspect());
  writeFileSync(f.path('hidden'),'ambient-state-changed');
  const after=JSON.stringify(f.kernel.inspect());

  assert.equal(after,before);
});

withFixture('active exact run fences amendment even when edge semantics are otherwise valid',f=>{
  f.defineFile('a',{content:'A1'});
  f.claim('a');

  assert.throws(
    ()=>f.rebindFile('a',{content:'A2'}),
    /PROJECT_BUSY|AMEND_WHILE_IN_FLIGHT/,
  );
});withFixture('material packet change invalidates an otherwise identical realization',f=>{
  f.defineFile('artifact',{content:'same-bytes',packet:{producer:'v1'}});
  f.settleFile('artifact');

  f.rebindFile('artifact',{content:'same-bytes',packet:{producer:'v2'}});

  assert.equal(f.work('artifact').status,'READY');
  assert.equal(f.work('artifact').run_id,undefined);
});


