import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  bindTaskSession,
  executeEffectReady,
} from '../../src/effect-broker.ts';
import { effectReadySignal } from '../../src/execution-signal.ts';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'effect-ready-red-team-'));
  const repo=join(root,'state.git');
  execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(repo);
  kernel.initialize();
  return {root,kernel};
}

function fakeGithub() {
  let writes=0;
  const fetchImpl:typeof fetch=async(input,init)=>{
    const url=String(input);
    if (url.endsWith('/repositories/123')) {
      return new Response(
        JSON.stringify({id:123,full_name:'owner/repo'}),
        {status:200,headers:{'Content-Type':'application/json'}},
      );
    }
    if (url.includes('/repos/owner/repo/statuses/')) {
      writes+=1;
      const body=JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id:1000+writes,
          state:body.state,
          context:body.context,
        }),
        {status:201,headers:{'Content-Type':'application/json'}},
      );
    }
    throw new Error('UNEXPECTED_FETCH:'+url);
  };
  return {
    fetchImpl,
    writes:()=>writes,
  };
}

function defineStatusObligation(
  kernel:GitOvercenterKernel,
  id:string,
  packet:Record<string,unknown>,
) {
  kernel.define({
    id,
    packet,
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/'+id,
      expected_state:'success',
    },
  });
  const work=kernel.deriveReadyWork();
  assert.ok(work);
  return kernel.claim(id,work.revision);
}

test('counterexample: late session binding lets an old signal inherit newer authority',async()=>{
  const f=fixture();
  try {
    const run=defineStatusObligation(
      f.kernel,
      'late-bind',
      {kind:'computation-task/v1'},
    );

    // This signal was emitted while the worker held generation 1.
    const generationOneSignal=effectReadySignal();

    // A trusted actor rotates execution authority before the broker consumes it.
    const generationTwo=f.kernel.acquireExecution(run.id);
    assert.equal(generationTwo.execution_generation,2);

    // Current hosted code reconstructs the TaskSession *after* the worker,
    // from current authority. The stale signal has no generation identity.
    const current=f.kernel.inspect().find(work=>work.id==='late-bind');
    assert.ok(current);
    assert.equal(current.execution_generation,2);
    const lateBoundSession=bindTaskSession(current);

    const github=fakeGithub();
    const attempt=await executeEffectReady(
      f.kernel,
      lateBoundSession,
      generationOneSignal,
      {
        githubToken:'broker-token',
        githubFetch:github.fetchImpl,
      },
    );

    assert.equal(attempt.broker_execution_generation,3);
    assert.equal(github.writes(),1);

    // The stale worker signal successfully crossed under generation 3.
    // expectedGeneration did not help because the session was rebound late.
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});

test('counterexample: an observe-only postcondition becomes mutation authority',async()=>{
  const f=fixture();
  try {
    defineStatusObligation(
      f.kernel,
      'observe-only',
      {
        kind:'observe-only/v1',
        mutation_authorized:false,
      },
    );

    const work=f.kernel.inspect().find(candidate=>candidate.id==='observe-only');
    assert.ok(work);
    assert.equal(work.packet.kind,'observe-only/v1');
    assert.equal(work.packet.mutation_authorized,false);

    const session=bindTaskSession(work);
    const github=fakeGithub();

    const attempt=await executeEffectReady(
      f.kernel,
      session,
      effectReadySignal(),
      {
        githubToken:'broker-token',
        githubFetch:github.fetchImpl,
      },
    );

    assert.equal(github.writes(),1);
    assert.equal(attempt.effect.operation,'create-commit-status');
    assert.equal(attempt.effect.context,'overcenter/observe-only');

    // No explicit mutation capability exists in the obligation. The effect
    // was minted solely from the verifier/postcondition shape.
  } finally {
    rmSync(f.root,{recursive:true,force:true});
  }
});
