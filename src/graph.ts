import type { Obligation } from './model.ts';
import type { State } from './facts.ts';

export interface GraphIndex {
  upstreams:ReadonlyMap<string,readonly string[]>;
  downstreams:ReadonlyMap<string,readonly string[]>;
  topologicalOrder:readonly string[];
}

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

export function buildGraphIndex(state:State):GraphIndex {
  const ids=Object.keys(state.obligations).sort();
  const upstreams=new Map<string,readonly string[]>();
  const downstreamLists=new Map<string,string[]>(
    ids.map(id=>[id,[]]),
  );

  for (const id of ids) {
    const dependencies=dependencyUpstreams(state.obligations[id]).sort();
    for (const dependency of dependencies) {
      if (!state.obligations[dependency]) {
        throw new Error(`UNKNOWN_DEPENDENCY:${id}:${dependency}`);
      }
      downstreamLists.get(dependency)!.push(id);
    }
    upstreams.set(id,dependencies);
  }

  const visiting=new Set<string>();
  const visited=new Set<string>();
  const topologicalOrder:string[]=[];
  const visit=(id:string):void=>{
    if (visiting.has(id)) throw new Error(`DEPENDENCY_CYCLE:${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of upstreams.get(id)??[]) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    topologicalOrder.push(id);
  };
  for (const id of ids) visit(id);

  const downstreams=new Map<string,readonly string[]>();
  for (const id of ids) {
    downstreams.set(id,downstreamLists.get(id)!.sort());
  }

  return {upstreams,downstreams,topologicalOrder};
}

export function validateGraph(state:State):void {
  buildGraphIndex(state);
}

export function graphDependsOn(
  index:GraphIndex,
  fromId:string,
  targetId:string,
):boolean {
  if (fromId===targetId) return true;
  const seen=new Set<string>();
  const pending=[fromId];
  while (pending.length>0) {
    const current=pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const dependency of index.upstreams.get(current)??[]) {
      if (dependency===targetId) return true;
      pending.push(dependency);
    }
  }
  return false;
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
