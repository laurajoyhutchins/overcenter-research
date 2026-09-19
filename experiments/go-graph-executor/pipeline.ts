import type { ExecutionPermit } from '../../src/model.ts';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import type { GraphExecutionEnvelope } from './adapter.ts';

export interface PipelinedClaim {
  permit:ExecutionPermit;
  envelope:GraphExecutionEnvelope;
}

// Claims remain ordinary Git-backed authority transitions. The only new
// behavior is immediate handoff: once one claim commits, its permit can start
// executing while the kernel commits later claims.
export function claimAndDispatchReadyFrontier(
  kernel:GitOvercenterKernel,
  {
    envelopeFor,
    dispatch,
    maxClaims=Number.MAX_SAFE_INTEGER,
  }:{
    envelopeFor:(permit:ExecutionPermit)=>GraphExecutionEnvelope;
    dispatch:(envelope:GraphExecutionEnvelope)=>void;
    maxClaims?:number;
  },
):PipelinedClaim[] {
  if (!Number.isSafeInteger(maxClaims) || maxClaims<0) {
    throw new Error('INVALID_PIPELINE_CLAIM_LIMIT');
  }

  const claimed:PipelinedClaim[]=[];
  while (claimed.length<maxClaims) {
    const ready=kernel.deriveReadyWork();
    if (!ready) break;

    // The claim is durable before the envelope is exposed to the executor.
    const permit=kernel.claim(ready.id,ready.revision);
    const envelope=envelopeFor(permit);
    dispatch(envelope);
    claimed.push({permit,envelope});
  }
  return claimed;
}
