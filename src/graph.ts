import type { Obligation } from './model.ts';
import type { ObligationCatalog } from './facts.ts';

export function dependencyUpstreams(obligation:Obligation):string[] {
  return [...new Set(obligation.dependencies.map(edge=>edge.upstream))];
}

export function withObligation(
  catalog:ObligationCatalog,
  obligation:Obligation,
  definitionCommit:string,
):State {
  return {
    obligations:{
      ...structuredClone(catalog.obligations),
      [obligation.id]:structuredClone(obligation),
    },
    definition_commits:{
      ...catalog.definition_commits,
      [obligation.id]:definitionCommit,
    },
  };
}

export function validateGraph(catalog:ObligationCatalog):void {
  for (const obligation of Object.values(catalog.obligations)) {
    for (const dependency of dependencyUpstreams(obligation)) {
      if (!catalog.obligations[dependency]) {
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
    for (const dependency of dependencyUpstreams(catalog.obligations[id])) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(catalog.obligations)) visit(id);
}

export function dependsOn(
  catalog:ObligationCatalog,
  fromId:string,
  targetId:string,
  seen=new Set<string>(),
):boolean {
  if (fromId===targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const work=catalog.obligations[fromId];
  if (!work) return false;
  return dependencyUpstreams(work)
    .some(dependency=>dependency===targetId || dependsOn(catalog,dependency,targetId,seen));
}
