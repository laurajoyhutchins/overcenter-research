import type { State } from './facts.ts';
import {
  dependsOn,
  validateGraph,
} from './graph.ts';
import {
  effectSemantics,
  settlementEquivalenceWitnessesAuthorizeUnorderedOverlap,
  settlementSemantics,
  verifiedContentIdentity,
} from './semantics.ts';

function validateSemanticEdges(state:State):void {
  for (const obligation of Object.values(state.obligations)) {
    for (const edge of obligation.dependencies) {
      if (edge.kind!=='semantic') continue;
      const upstream=state.obligations[edge.upstream];
      if (!upstream) {
        throw new Error(`UNKNOWN_DEPENDENCY:${obligation.id}:${edge.upstream}`);
      }
      if (edge.consumes.kind==='output') {
        if (edge.consumes.selector!=='verified-content') {
          throw new Error(
            `UNSUPPORTED_SEMANTIC_SELECTOR:output:${edge.consumes.selector}`,
          );
        }
        if (!verifiedContentIdentity(upstream.postcondition)) {
          throw new Error(
            `UNAVAILABLE_SEMANTIC_OUTPUT:${obligation.id}:${edge.upstream}:verified-content`,
          );
        }
        continue;
      }
      if (
        edge.consumes.kind!=='evidence'
        || edge.consumes.selector!=='settlement-receipt'
      ) {
        throw new Error(
          `UNSUPPORTED_SEMANTIC_SELECTOR:${edge.consumes.kind}:${edge.consumes.selector}`,
        );
      }
    }
  }
}

export function staticEffectConflictError(
  state:State,
  workId:string,
):string|null {
  const work=state.obligations[workId];
  const workIsEffect=Boolean(
    work?.effect_authority || state.legacy_effect_ids?.[workId],
  );
  if (!work || !workIsEffect) return null;
  const semantics=effectSemantics(work.postcondition);
  if (!semantics) throw new Error('EFFECT_AUTHORITY_WITHOUT_EFFECT_SEMANTICS');

  for (const other of Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))) {
    if (other.id===work.id) continue;
    const otherIsEffect=Boolean(
      other.effect_authority || state.legacy_effect_ids?.[other.id],
    );
    if (!otherIsEffect) continue;
    const otherSemantics=effectSemantics(other.postcondition);
    if (!otherSemantics || otherSemantics.resource!==semantics.resource) continue;

    if (
      settlementEquivalenceWitnessesAuthorizeUnorderedOverlap(
        work.postcondition,
        other.postcondition,
      )
    ) continue;

    const ordered=dependsOn(state,work.id,other.id)
      || dependsOn(state,other.id,work.id);
    if (!ordered) {
      const [left,right]=[work.id,other.id].sort();
      return `UNORDERED_EFFECT_CONFLICT:${left}:${right}`;
    }
  }
  return null;
}

function validateStaticEffectOrdering(state:State):void {
  for (const obligation of Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))) {
    const error=staticEffectConflictError(state,obligation.id);
    if (error) throw new Error(error);
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
