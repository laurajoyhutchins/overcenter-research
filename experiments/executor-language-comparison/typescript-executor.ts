import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  GraphExecutionEnvelope,
  GraphExecutionEvidence,
} from '../go-graph-executor/adapter.ts';

export type TypeScriptRunner=(
  signal:AbortSignal,
  envelope:GraphExecutionEnvelope,
)=>Promise<Buffer>;

function identityKey(envelope:GraphExecutionEnvelope):string {
  return [
    envelope.run_id,
    envelope.execution_generation,
    envelope.execution_authority_commit,
  ].join('/');
}

function validateEnvelope(
  envelope:GraphExecutionEnvelope,
  seen:Set<string>,
):void {
  if (!envelope.run_id || !envelope.obligation_id) {
    throw new Error('invalid execution identity');
  }
  if (!Number.isSafeInteger(envelope.execution_generation) || envelope.execution_generation<=0) {
    throw new Error('invalid execution generation');
  }
  if (!envelope.execution_authority_commit || !envelope.claimed_revision) {
    throw new Error('incomplete execution authority');
  }
  if (!envelope.execution_capability || !envelope.execution_capability_sha256) {
    throw new Error('missing execution capability');
  }
  if (!envelope.execution_spec_sha256) {
    throw new Error('missing execution spec digest');
  }
  const capabilityDigest=createHash('sha256')
    .update(envelope.execution_capability)
    .digest('hex');
  if (capabilityDigest!==envelope.execution_capability_sha256) {
    throw new Error('execution capability digest mismatch');
  }
  const specBytes=Buffer.from(JSON.stringify(envelope.execution_spec));
  const specDigest='sha256:'+createHash('sha256').update(specBytes).digest('hex');
  if (specDigest!==envelope.execution_spec_sha256) {
    throw new Error('execution spec digest mismatch');
  }
  const key=identityKey(envelope);
  if (seen.has(key)) {
    throw new Error(`duplicate execution identity: ${key}`);
  }
  seen.add(key);
}

async function executeOne(
  signal:AbortSignal,
  envelope:GraphExecutionEnvelope,
  runner:TypeScriptRunner,
):Promise<GraphExecutionEvidence> {
  const evidence:GraphExecutionEvidence={
    schema:'overcenter-execution-attempt-evidence-v1',
    run_id:envelope.run_id,
    obligation_id:envelope.obligation_id,
    claimed_revision:envelope.claimed_revision,
    execution_generation:envelope.execution_generation,
    execution_authority_commit:envelope.execution_authority_commit,
    execution_capability_sha256:envelope.execution_capability_sha256,
    ...(envelope.effect_reservation_commit
      ? {effect_reservation_commit:envelope.effect_reservation_commit}
      : {}),
    execution_spec_sha256:envelope.execution_spec_sha256,
    outcome:'failed',
  };

  if (signal.aborted) {
    return {...evidence,outcome:'cancelled',error:String(signal.reason??'aborted')};
  }

  try {
    const output=await runner(signal,envelope);
    return {
      ...evidence,
      outcome:'completed',
      output_base64:output.toString('base64'),
      output_sha256:'sha256:'+createHash('sha256').update(output).digest('hex'),
    };
  } catch (error) {
    if (signal.aborted) {
      return {...evidence,outcome:'cancelled',error:String(signal.reason??'aborted')};
    }
    return {...evidence,outcome:'failed',error:error instanceof Error?error.message:String(error)};
  }
}

export async function* executeStream(
  signal:AbortSignal,
  envelopes:AsyncIterable<GraphExecutionEnvelope>,
  maxConcurrency:number,
  runner:TypeScriptRunner,
):AsyncGenerator<GraphExecutionEvidence> {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency<=0) {
    throw new Error('max concurrency must be positive');
  }

  const seen=new Set<string>();
  const active=new Map<number,Promise<{token:number;evidence:GraphExecutionEvidence}>>();
  let token=0;

  const drainOne=async():Promise<GraphExecutionEvidence>=>{
    const settled=await Promise.race(active.values());
    active.delete(settled.token);
    return settled.evidence;
  };

  for await (const envelope of envelopes) {
    if (signal.aborted) break;
    validateEnvelope(envelope,seen);

    while (active.size>=maxConcurrency) {
      yield await drainOne();
    }

    const current=token++;
    active.set(
      current,
      executeOne(signal,envelope,runner)
        .then(evidence=>({token:current,evidence})),
    );
  }

  while (active.size>0) {
    yield await drainOne();
  }
}

interface SubprocessSpec {
  fixture:string;
  mode:'complete'|'fail'|'hang'|'grandchild-hang';
  result?:string;
  pid_file?:string;
}

function killProcessGroup(pid:number,signal:NodeJS.Signals):void {
  try {
    process.kill(-pid,signal);
  } catch (error) {
    const code=(error as NodeJS.ErrnoException).code;
    if (code!=='ESRCH') throw error;
  }
}

export async function runSupervisedSubprocess(
  signal:AbortSignal,
  envelope:GraphExecutionEnvelope,
):Promise<Buffer> {
  const spec=envelope.execution_spec as SubprocessSpec;
  if (!spec?.fixture || !spec?.mode) throw new Error('invalid subprocess spec');

  return await new Promise<Buffer>((resolve,reject)=>{
    const child=spawn(process.execPath,[spec.fixture,spec.mode,spec.result??'',spec.pid_file??''],{
      detached:true,
      stdio:['ignore','pipe','pipe'],
    });
    const stdout:Buffer[]=[];
    const stderr:Buffer[]=[];
    let terminationTimer:NodeJS.Timeout|undefined;
    let settled=false;

    const cleanup=()=>{
      signal.removeEventListener('abort',onAbort);
      if (terminationTimer) clearTimeout(terminationTimer);
    };
    const finish=(fn:()=>void)=>{
      if (settled) return;
      settled=true;
      cleanup();
      fn();
    };
    const onAbort=()=>{
      if (child.pid) {
        killProcessGroup(child.pid,'SIGTERM');
        terminationTimer=setTimeout(()=>{
          if (child.pid) killProcessGroup(child.pid,'SIGKILL');
        },50);
      }
    };

    child.stdout.on('data',chunk=>stdout.push(Buffer.from(chunk)));
    child.stderr.on('data',chunk=>stderr.push(Buffer.from(chunk)));
    child.once('error',error=>finish(()=>reject(error)));
    child.once('close',(code,childSignal)=>{
      finish(()=>{
        if (signal.aborted) {
          reject(signal.reason instanceof Error?signal.reason:new Error('aborted'));
        } else if (code!==0) {
          reject(new Error(
            `child failed code=${String(code)} signal=${String(childSignal)} stderr=${Buffer.concat(stderr).toString('utf8')}`,
          ));
        } else {
          resolve(Buffer.concat(stdout));
        }
      });
    });

    signal.addEventListener('abort',onAbort,{once:true});
    if (signal.aborted) onAbort();
  });
}
