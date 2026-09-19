import type { Obligation } from '../model.ts';
import type { State } from '../authority/facts.ts';

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
