import { createInterface } from 'node:readline';
import { executeStream,runSupervisedSubprocess } from './typescript-executor.ts';
import type { GraphExecutionEnvelope } from '../go-graph-executor/adapter.ts';

function argument(name:string,fallback:string):string {
  const prefix='--'+name+'=';
  return process.argv.find(value=>value.startsWith(prefix))?.slice(prefix.length)??fallback;
}

const concurrency=Number.parseInt(argument('concurrency','8'),10);
const timeoutMillis=Number.parseInt(argument('timeout-ms','30000'),10);
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(new Error('context deadline exceeded')),timeoutMillis);

async function* input():AsyncGenerator<GraphExecutionEnvelope> {
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await (const line of lines) {
    if (!line.trim()) continue;
    yield JSON.parse(line) as GraphExecutionEnvelope;
  }
}

try {
  for await (const evidence of executeStream(
    controller.signal,
    input(),
    concurrency,
    runSupervisedSubprocess,
  )) {
    process.stdout.write(JSON.stringify(evidence)+'\n');
  }
} catch (error) {
  process.stderr.write((error instanceof Error?error.stack:String(error))+'\n');
  process.exitCode=1;
} finally {
  clearTimeout(timer);
}
