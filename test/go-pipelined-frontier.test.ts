import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assertExecutionEvidenceFor,
  executionEnvelope,
  type GraphExecutionEnvelope,
  type GraphExecutionEvidence,
} from '../experiments/go-graph-executor/adapter.ts';
import {
  claimAndDispatchComputationFrontier,
  claimReserveAndDispatchEffectFrontier,
} from '../experiments/go-graph-executor/pipeline.ts';
import { GitOvercenterKernel } from '../src/git-kernel.ts';
import type { ExecutionPermit } from '../src/model.ts';

const experimentDir=fileURLToPath(new URL('../experiments/go-graph-executor/',import.meta.url));
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

function envelopeFor(
  permit:ExecutionPermit,
  delayMillis=5,
  effectReservationCommit?:string,
):GraphExecutionEnvelope {
  const executionSpec={
    delay_ms:delayMillis,
    result:`candidate:${permit.obligation_id}:g${permit.execution_generation}`,
  };
  return executionEnvelope(permit,{
    executionSpec,
    executionSpecSha256:`sha256:${sha256(JSON.stringify(executionSpec))}`,
    ...(effectReservationCommit?{effectReservationCommit}:{}),
  });
}

class GoExecutionStream {
  readonly evidence:GraphExecutionEvidence[]=[];
  readonly stderr:string[]=[];
  readonly child;
  readonly #waiters:Array<()=>void>=[];
  readonly #closed:Promise<number|null>;

  constructor(concurrency=4) {
    this.child=spawn(
      'go',
      ['run','./cmd/execute-stream',`--concurrency=${concurrency}`,'--timeout=10s'],
      {cwd:experimentDir,stdio:['pipe','pipe','pipe']},
    );
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data',chunk=>this.stderr.push(String(chunk)));
    const lines=createInterface({input:this.child.stdout});
    lines.on('line',line=>{
      this.evidence.push(JSON.parse(line) as GraphExecutionEvidence);
      for (const wake of this.#waiters.splice(0)) wake();
    });
    this.#closed=new Promise((resolve,reject)=>{
      this.child.once('error',reject);
      this.child.once('close',resolve);
    });
  }

  send(envelope:GraphExecutionEnvelope):void {
    this.child.stdin.write(JSON.stringify(envelope)+'\n');
  }

  async waitForEvidence(count:number,timeoutMillis=5000):Promise<void> {
    if (this.evidence.length>=count) return;
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(
        ()=>reject(new Error(`timed out waiting for ${count} evidence records; got ${this.evidence.length}`)),
        timeoutMillis,
      );
      const check=()=>{
        if (this.evidence.length>=count) {
          clearTimeout(timer);
          resolve();
          return;
        }
        this.#waiters.push(check);
      };
      this.#waiters.push(check);
    });
  }

  async close():Promise<void> {
    this.child.stdin.end();
    const code=await this.#closed;
    assert.equal(code,0,this.stderr.join(''));
  }
}

function makeKernel(ids:string[]):{root:string;repo:string;kernel:GitOvercenterKernel} {
  const root=mkdtempSync(join(tmpdir(),'overcenter-pipeline-'));
  const repo=join(root,'repo');
  execFileSync('git',['init',repo],{stdio:'ignore'});
  execFileSync('git',['-C',repo,'config','user.email','test@example.com']);
  execFileSync('git',['-C',repo,'config','user.name','Test']);
  const kernel=new GitOvercenterKernel(repo);
  kernel.initialize();
  for (const id of ids) {
    kernel.define({
      id,
      packet:{kind:'pipelined-frontier-proof',id},
      postcondition:{
        verifier:'file-content-equals/v1',
        path:`/provider/${id}`,
        content:id,
      },
    });
  }
  return {root,repo,kernel};
}

test('first durable permit executes before the authority frontier stream closes',async()=>{
  const {root,kernel}=makeKernel(['alpha','beta','gamma','delta']);
  const go=new GoExecutionStream(2);
  try {
    const firstReady=kernel.deriveReadyWork();
    assert.ok(firstReady);
    const firstPermit=kernel.claim(firstReady.id,firstReady.revision);
    const firstEnvelope=envelopeFor(firstPermit);
    go.send(firstEnvelope);

    // Do not claim beta/gamma/delta yet and deliberately keep stdin open.
    // Receiving alpha evidence now proves Go does not wait for a batch/frontier
    // closure before starting authorized work.
    await go.waitForEvidence(1);
    assertExecutionEvidenceFor(go.evidence[0],firstEnvelope);
    assert.equal(kernel.deriveReadyFrontier().length,3);

    const rest=claimAndDispatchComputationFrontier(kernel,{
      envelopeFor:permit=>envelopeFor(permit),
      dispatch:envelope=>go.send(envelope),
    });
    assert.equal(rest.length,3);

    await go.close();
    assert.equal(go.evidence.length,4);
    for (const {envelope} of rest) {
      const evidence=go.evidence.find(item=>item.run_id===envelope.run_id);
      assert.ok(evidence);
      assertExecutionEvidenceFor(evidence,envelope);
    }
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('claim-then-crash gap reconstructs from Git without a scheduler queue',async()=>{
  const {root,repo,kernel}=makeKernel(['alpha']);
  try {
    const ready=kernel.deriveReadyWork();
    assert.ok(ready);
    const abandonedPermit=kernel.claim(ready.id,ready.revision);
    const abandonedEnvelope=envelopeFor(abandonedPermit,1);

    // Simulate process death after durable claim and before dispatch by
    // discarding the kernel object and never sending abandonedEnvelope.
    const restarted=new GitOvercenterKernel(repo);
    const [projected]=restarted.inspect();
    assert.equal(projected.status,'EXECUTING');
    assert.equal(projected.run_id,abandonedPermit.id);
    assert.equal(projected.execution_generation,1);

    // Recovery is explicit because the executor's death is known. Acquiring
    // fresh authority fences out any delayed generation-1 execution.
    const recoveredPermit=restarted.acquireExecution(abandonedPermit.id);
    assert.equal(recoveredPermit.execution_generation,2);

    const recoveredEnvelope=envelopeFor(recoveredPermit,1);
    const go=new GoExecutionStream(1);
    go.send(recoveredEnvelope);
    await go.close();

    assert.equal(go.evidence.length,1);
    const [evidence]=go.evidence;
    assertExecutionEvidenceFor(evidence,recoveredEnvelope);
    assert.throws(
      ()=>assertExecutionEvidenceFor(evidence,abandonedEnvelope),
      /EXECUTION_EVIDENCE_AUTHORITY_MISMATCH/,
    );
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('dispatch failure leaves an ordinary durable claim, not hidden pipeline state',()=>{
  const {root,repo,kernel}=makeKernel(['alpha','beta']);
  try {
    assert.throws(
      ()=>claimAndDispatchComputationFrontier(kernel,{
        envelopeFor:permit=>envelopeFor(permit),
        dispatch:()=>{throw new Error('synthetic transport death');},
      }),
      /synthetic transport death/,
    );

    const restarted=new GitOvercenterKernel(repo);
    const work=new Map(restarted.inspect().map(item=>[item.id,item]));
    assert.equal(work.get('alpha')?.status,'EXECUTING');
    assert.equal(work.get('beta')?.status,'READY');
    assert.ok(work.get('alpha')?.run_id);

    const recovered=restarted.acquireExecution(work.get('alpha')!.run_id!);
    assert.equal(recovered.execution_generation,2);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});


test('effectful pipeline reserves mutation before dispatch and binds reservation through evidence',async()=>{
  const {root,kernel}=makeKernel(['alpha']);
  const go=new GoExecutionStream(1);
  try {
    const [claimed]=claimReserveAndDispatchEffectFrontier(kernel,{
      envelopeFor:(permit,reservationCommit)=>envelopeFor(permit,1,reservationCommit),
      dispatch:envelope=>go.send(envelope),
    });
    assert.ok(claimed.effect_reservation_commit);
    assert.equal(
      claimed.envelope.effect_reservation_commit,
      claimed.effect_reservation_commit,
    );

    await go.close();
    assert.equal(go.evidence.length,1);
    assertExecutionEvidenceFor(go.evidence[0],claimed.envelope);
    assert.equal(
      go.evidence[0].effect_reservation_commit,
      claimed.effect_reservation_commit,
    );
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('crash after effect reservation cannot be recovered by blind re-execution',()=>{
  const {root,repo,kernel}=makeKernel(['alpha']);
  try {
    assert.throws(
      ()=>claimReserveAndDispatchEffectFrontier(kernel,{
        envelopeFor:(permit,reservationCommit)=>envelopeFor(permit,1,reservationCommit),
        dispatch:()=>{throw new Error('crash after reservation before transport');},
      }),
      /crash after reservation before transport/,
    );

    const restarted=new GitOvercenterKernel(repo);
    const [projected]=restarted.inspect();
    assert.equal(projected.status,'EXECUTING');
    assert.ok(projected.run_id);

    const recovered=restarted.acquireExecution(projected.run_id);
    assert.equal(recovered.execution_generation,2);

    // The unresolved generation-1 reservation survives authority reacquisition,
    // so a fresh mutation cannot be reserved or replayed.
    assert.throws(
      ()=>restarted.beginEffect(recovered),
      /UNRESOLVED_EFFECT/,
    );

    // Independent observation resolves the ambiguity. This fixture never
    // dispatched the effect, so authoritative ENOENT makes the run READY and
    // clears the reservation rather than guessing that replay is safe.
    const receipt=restarted.resolve(recovered);
    assert.equal(receipt.disposition,'READY');
    assert.equal(restarted.inspect()[0].status,'READY');

    const retry=restarted.claim('alpha',restarted.head()!);
    const reservation=restarted.beginEffect(retry);
    assert.ok(reservation);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
