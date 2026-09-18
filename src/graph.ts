import type { Obligation } from './model.ts';
import type { State } from './facts.ts';
import {
  effectSemantics,
  verifiedContentIdentity,
} from './semantics.ts';

export function dependencyUpstreams(obligation:Obligation):string[] {
  return [...new Set(obligation.dependencies.map(edge=>edge.upstream))];
}

export function withObligation(
  state:State,
  obligation:Obligation,
  definitionCommit:string,
):State {
  return {
    obligations:{
      ...structuredClone(state.obligations),
      [obligation.id]:structuredClone(obligation),
    },
    definition_commits:{
      ...state.definition_commits,
      [obligation.id]:definitionCommit,
    },
  };
}

export function dependsOn(
  state:State,
  fromId:string,
  targetId:string,
  seen=new Set<string>(),
):boolean {
  if (fromId===targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const work=state.obligations[fromId];
  if (!work) return false;
  return dependencyUpstreams(work)
    .some(dependency=>dependency===targetId || dependsOn(state,dependency,targetId,seen));
}

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

function validateStaticEffectOrdering(state:State):void {
  const obligations=Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id));

  for (let i=0;i<obligations.length;i+=1) {
    const left=obligations[i];
    const leftSemantics=effectSemantics(left.postcondition);
    if (!leftSemantics) continue;

    for (let j=i+1;j<obligations.length;j+=1) {
      const right=obligations[j];
      const rightSemantics=effectSemantics(right.postcondition);
      if (!rightSemantics || rightSemantics.resource!==leftSemantics.resource) continue;

      const sameDesired=rightSemantics.desired===leftSemantics.desired;
      if (
        sameDesired
        && leftSemantics.sameDesiredCommutes
        && rightSemantics.sameDesiredCommutes
      ) continue;

      const ordered=dependsOn(state,left.id,right.id)
        || dependsOn(state,right.id,left.id);
      if (!ordered) {
        throw new Error(`UNORDERED_EFFECT_CONFLICT:${left.id}:${right.id}`);
      }
    }
  }
}

export function validateGraph(state:State):void {
  for (const obligation of Object.values(state.obligations)) {
    for (const dependency of dependencyUpstreams(obligation)) {
      if (!state.obligations[dependency]) {
        throw new Error(`UNKNOWN_DEPENDENCY:${obligation.id}:${dependency}`);
      }
    }
  }

  const visiting=new Set<string>();
  const visited=new Set<string>();
  const visit=(id:string):void=>{
    if (visiting.has(id)) throw new Error(`DEPENDENCY_CYCLE:${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencyUpstreams(state.obligations[id])) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(state.obligations)) visit(id);

  validateSemanticEdges(state);
  validateStaticEffectOrdering(state);
}