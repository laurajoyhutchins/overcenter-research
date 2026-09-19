import type { ExecutionPermit } from '../../src/model.ts';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import type { GraphExecutionEnvelope } from './adapter.ts';

export interface PipelinedClaim {
  permit:ExecutionPermit;
  envelope:GraphExecutionEnvelope;
  effect_reservation_commit?:string;
}

function validateLimit(maxClaims:number):void {
  if (!Number.isSafeInteger(maxClaims) || maxClaims<0) {
    throw new Error('INVALID_PIPELINE_CLAIM_LIMIT');
  }
}

// This path is only for computation whose execution boundary cannot mutate an
// external provider. Claims remain ordinary Git-backed authority transitions;
// once one claim commits, computation can overlap later claim issuance.
export function claimAndDispatchComputationFrontier(
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
  validateLimit(maxClaims);

  const claimed:PipelinedClaim[]=[];
  while (claimed.length<maxClaims) {
    const ready=kernel.deriveReadyWork();
    if (!ready) break;

    const permit=kernel.claim(ready.id,ready.revision);
    const envelope=envelopeFor(permit);
    if (envelope.effect_reservation_commit) {
      throw new Error('COMPUTATION_ENVELOPE_CANNOT_CARRY_EFFECT_RESERVATION');
    }
    dispatch(envelope);
    claimed.push({permit,envelope});
  }
  return claimed;
}

// Any streamed execution that may mutate an external provider is fenced by the
// existing durable effect reservation before its envelope crosses the process
// boundary. A crash after this point is intentionally ambiguous and must be
// reconciled by observation; it must not be replayed as fresh work.
export function claimReserveAndDispatchEffectFrontier(
  kernel:GitOvercenterKernel,
  {
    envelopeFor,
    dispatch,
    maxClaims=Number.MAX_SAFE_INTEGER,
  }:{
    envelopeFor:(
      permit:ExecutionPermit,
      effectReservationCommit:string,
    )=>GraphExecutionEnvelope;
    dispatch:(envelope:GraphExecutionEnvelope)=>void;
    maxClaims?:number;
  },
):PipelinedClaim[] {
  validateLimit(maxClaims);

  const claimed:PipelinedClaim[]=[];
  while (claimed.length<maxClaims) {
    const ready=kernel.deriveReadyWork();
    if (!ready) break;

    const permit=kernel.claim(ready.id,ready.revision);
    const effectReservationCommit=kernel.beginEffect(permit);
    const envelope=envelopeFor(permit,effectReservationCommit);
    if (envelope.effect_reservation_commit!==effectReservationCommit) {
      throw new Error('EFFECT_ENVELOPE_RESERVATION_MISMATCH');
    }
    dispatch(envelope);
    claimed.push({permit,envelope,effect_reservation_commit:effectReservationCommit});
  }
  return claimed;
}
