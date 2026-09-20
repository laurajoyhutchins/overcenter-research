import type { State } from './facts.ts';
import {
  dependsOn,
  validateGraph,
} from './graph.ts';
import {
  effectSemantics,
  settlementSemantics,
  verifiedContentIdentity,
} from './semantics.ts';
import { semanticDependencySelection } from './semantic-dependency.ts';

function validateSemanticEdges(state:State):void {
  for (const obligation of Object.values(state.obligations)) {
    for (const edge of obligation.dependencies) {
      if (edge.kind!=='semantic') continue;
      const upstream=state.obligations[edge.upstream];
      if (!upstream) {
        throw new Error(`UNKNOWN_DEPENDENCY:${obligation.id}:${edge.upstream}`);
      }
      const selection=semanticDependencySelection(edge);
      if (
        selection==='verified-content'
        && !verifiedContentIdentity(upstream.postcondition)
      ) {
        throw new Error(
          `UNAVAILABLE_SEMANTIC_OUTPUT:${obligation.id}:${edge.upstream}:verified-content`,
        );
      }
    }
  }
}

export interface StaticEffectConflict {
  left:string;
  right:string;
  code:string;
}

export function staticEffectConflict(
  state:State,
  workId:string,
):StaticEffectConflict|null {
  const work=state.obligations[workId];
  if (!work) return null;
  const semantics=effectSemantics(work.postcondition);
  if (!semantics) return null;

  for (const other of Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))) {
    if (other.id===work.id) continue;
    const otherSemantics=effectSemantics(other.postcondition);
    if (!otherSemantics || otherSemantics.resource!==semantics.resource) continue;

    const sameDesired=otherSemantics.desired===semantics.desired;
    if (
      sameDesired
      && semantics.sameDesiredCommutes
      && otherSemantics.sameDesiredCommutes
    ) continue;

    const ordered=dependsOn(state,work.id,other.id)
      || dependsOn(state,other.id,work.id);
    if (!ordered) {
      const [left,right]=[work.id,other.id].sort();
      return {
        left,
        right,
        code:`UNORDERED_EFFECT_CONFLICT:${left}:${right}`,
      };
    }
  }
  return null;
}

function validateStaticEffectOrdering(state:State):void {
  for (const obligation of Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))) {
    const conflict=staticEffectConflict(state,obligation.id);
    if (conflict) throw new Error(conflict.code);
  }
}

export function validateAdmission(state:State):void {
  validateGraph(state);
  for (const obligation of Object.values(state.obligations)) {
    settlementSemantics(obligation.postcondition);
  }
  validateSemanticEdges(state);
  validateStaticEffectOrdering(state);
}
