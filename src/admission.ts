import type { ObligationCatalog } from './facts.ts';
import {
  dependsOn,
  validateGraph,
} from './graph.ts';
import {
  effectConflictSemantics,
  settlementSemantics,
  verifiedRealizationIdentity,
} from './semantics.ts';

function validateSemanticEdges(catalog:ObligationCatalog):void {
  for (const obligation of Object.values(catalog.obligations)) {
    for (const edge of obligation.dependencies) {
      if (edge.kind!=='semantic') continue;
      const upstream=catalog.obligations[edge.upstream];
      if (!upstream) {
        throw new Error(`UNKNOWN_DEPENDENCY:${obligation.id}:${edge.upstream}`);
      }
      if (edge.consumes.kind==='output') {
        if (edge.consumes.selector!=='verified-content') {
          throw new Error(
            `UNSUPPORTED_SEMANTIC_SELECTOR:output:${edge.consumes.selector}`,
          );
        }
        if (!verifiedRealizationIdentity(upstream.postcondition)) {
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
  catalog:ObligationCatalog,
  workId:string,
):string|null {
  const work=catalog.obligations[workId];
  if (!work) return null;
  const semantics=effectConflictSemantics(work.postcondition);
  if (!semantics) return null;

  for (const other of Object.values(catalog.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))) {
    if (other.id===work.id) continue;
    const otherSemantics=effectConflictSemantics(other.postcondition);
    if (!otherSemantics || otherSemantics.coordinate!==semantics.coordinate) continue;

    const sameDesired=otherSemantics.desiredState===semantics.desiredState;
    if (
      sameDesired
      && semantics.sameDesiredCommutes
      && otherSemantics.sameDesiredCommutes
    ) continue;

    const ordered=dependsOn(catalog,work.id,other.id)
      || dependsOn(catalog,other.id,work.id);
    if (!ordered) {
      const [left,right]=[work.id,other.id].sort();
      return `UNORDERED_EFFECT_CONFLICT:${left}:${right}`;
    }
  }
  return null;
}

function validateStaticEffectOrdering(catalog:ObligationCatalog):void {
  for (const obligation of Object.values(catalog.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))) {
    const error=staticEffectConflictError(catalog,obligation.id);
    if (error) throw new Error(error);
  }
}

export function validateAdmission(catalog:ObligationCatalog):void {
  validateGraph(catalog);
  for (const obligation of Object.values(catalog.obligations)) {
    settlementSemantics(obligation.postcondition);
  }
  validateSemanticEdges(catalog);
  validateStaticEffectOrdering(catalog);
}
