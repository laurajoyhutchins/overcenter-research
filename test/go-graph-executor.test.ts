import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assertExecutionEvidenceFor,
  type GraphExecutionEnvelope,
  type GraphExecutionEvidence,
} from '../experiments/go-graph-executor/adapter.ts';
import { stressPlan } from '../experiments/go-graph-executor/stress-fixture.ts';

const experimentDir=fileURLToPath(new URL('../experiments/go-graph-executor/',import.meta.url));

async function execute(
  executions:GraphExecutionEnvelope[],
  concurrency:number,
  timeout='5s',
):Promise<GraphExecutionEvidence[]> {
  const child=spawn(
    'go',
    ['run','./cmd/execute-frontier',`--concurrency=${concurrency}`,`--timeout=${timeout}`],
    {cwd:experimentDir,stdio:['pipe','pipe','pipe']},
  );
  let stdout='';
  let stderr='';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.end(JSON.stringify({executions}));

  const code=await new Promise<number|null>((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',resolve);
  });
  assert.equal(code,0,stderr);
  return JSON.parse(stdout) as GraphExecutionEvidence[];
}

function normalized(evidence:GraphExecutionEvidence[]) {
  return evidence
    .map(item=>({
      ...item,
      error:item.error?.replace(/context deadline exceeded/g,'context deadline exceeded'),
    }))
    .sort((a,b)=>a.run_id.localeCompare(b.run_id));
}

test('completion interleaving does not change execution evidence for the same frontier',async()=>{
  const plan=stressPlan().filter(item=>!item.obligation_id.startsWith('hang-'));
  assert.equal(plan.length,735);

  const serial=await execute(plan,1);
  const eight=await execute(plan,8);
  const fiveHundred=await execute(plan,500);

  assert.deepEqual(normalized(eight),normalized(serial));
  assert.deepEqual(normalized(fiveHundred),normalized(serial));

  assert.deepEqual(serial.map(item=>item.run_id),plan.map(item=>item.run_id));
  assert.notDeepEqual(
    fiveHundred.slice(0,25).map(item=>item.run_id),
    serial.slice(0,25).map(item=>item.run_id),
    'hostile run must actually exercise a different completion order',
  );

  for (const evidence of fiveHundred) {
    const envelope=plan.find(item=>item.run_id===evidence.run_id);
    assert.ok(envelope);
    assertExecutionEvidenceFor(evidence,envelope);
  }

  assert.equal(serial.filter(item=>item.outcome==='completed').length,710);
  assert.equal(serial.filter(item=>item.outcome==='failed').length,25);
});

test('1,000-node graph frontier physically executes quick work while hung work cancels',async()=>{
  const plan=stressPlan();
  assert.equal(plan.length,760);

  const evidence=await execute(plan,500,'150ms');
  assert.equal(evidence.length,760);
  assert.equal(evidence.filter(item=>item.outcome==='completed').length,710);
  assert.equal(evidence.filter(item=>item.outcome==='failed').length,25);
  assert.equal(evidence.filter(item=>item.outcome==='cancelled').length,25);

  for (const item of evidence.filter(candidate=>candidate.outcome==='cancelled')) {
    assert.equal(item.output_sha256,undefined);
    assert.equal(item.output_base64,undefined);
  }
});

test('late evidence from a superseded execution generation is rejected before interpretation',async()=>{
  const envelope=stressPlan()[0];
  const [evidence]=await execute([envelope],1);
  assertExecutionEvidenceFor(evidence,envelope);

  const stale=structuredClone(evidence);
  stale.execution_generation+=1;
  assert.throws(
    ()=>assertExecutionEvidenceFor(stale,envelope),
    /EXECUTION_EVIDENCE_AUTHORITY_MISMATCH/,
  );
});

test('Go executor source contains no graph lifecycle or settlement vocabulary',async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(
    new URL('../experiments/go-graph-executor/executor.go',import.meta.url),
    'utf8',
  );
  for (const forbidden of [
    'dependency',
    'upstream',
    'READY',
    'BLOCKED',
    'DONE',
    'settlement',
    'claimability',
  ]) {
    assert.equal(source.includes(forbidden),false,`forbidden semantic vocabulary: ${forbidden}`);
  }
});
