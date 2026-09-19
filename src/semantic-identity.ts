import type {
  Dependency,
  Obligation,
} from './model.ts';
import type {
  Receipt,
  State,
} from './facts.ts';
import type { Lifecycle } from './projector.ts';
import { canonicalDigest } from './digest.ts';
import { verifiedContentIdentity } from './semantics.ts';
import {
  semanticDependencySelection,
  type SemanticDependency,
} from './semantic-dependency.ts';

function semanticDependencyIdentity(
  state:State,
  edge:SemanticDependency,
  lifecycles:Map<string,Lifecycle>,
  receiptsByRun:Map<string,Receipt>,
):string|null {
  const upstream=state.obligations[edge.upstream];
  if (!upstream) throw new Error(`UNKNOWN_DEPENDENCY:${edge.upstream}`);
  const lifecycle=lifecycles.get(edge.upstream);
  if (lifecycle?.status!=='DONE' || !lifecycle.run) return null;

  const selection=semanticDependencySelection(edge);
  if (selection==='verified-content') {
    return verifiedContentIdentity(upstream.postcondition);
  }

  const receipt=receiptsByRun.get(lifecycle.run.id);
  if (receipt?.disposition!=='DONE' || !receipt.settlement_commit) return null;
  return `settlement:${receipt.settlement_commit}`;
}

export function obligationKey(
  state:State,
  work:Obligation,
  lifecycles:Map<string,Lifecycle>,
  receiptsByRun:Map<string,Receipt>,
):string|null {
  const semantic=work.dependencies
    .filter((edge):edge is SemanticDependency=>edge.kind==='semantic');

  const consumed:Array<{
    consumes:SemanticDependency['consumes'];
    identity:string;
  }>=[];
  for (const edge of semantic) {
    const identity=semanticDependencyIdentity(state,edge,lifecycles,receiptsByRun);
    if (!identity) return null;
    consumed.push({
      consumes:structuredClone(edge.consumes),
      identity,
    });
  }
  consumed.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return canonicalDigest({
    id:work.id,
    packet:work.packet,
    postcondition:work.postcondition,
    semantic_dependencies:consumed,
  });
}
