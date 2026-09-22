import type { State } from './facts.ts';
import {
  buildGraphIndex,
  type GraphIndex,
} from './graph.ts';
import {
  effectSemantics,
  settlementSemantics,
  verifiedContentIdentity,
  type EffectSemantics,
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

interface IndexedEffect {
  id:string;
  semantics:EffectSemantics;
  bit:bigint;
}

export interface StaticEffectIndex {
  graph:GraphIndex;
  byId:ReadonlyMap<string,IndexedEffect>;
  byResource:ReadonlyMap<string,readonly IndexedEffect[]>;
  resourceMasks:ReadonlyMap<string,bigint>;
  commutingMasks:ReadonlyMap<string,ReadonlyMap<string,bigint>>;
  orderedBitsById:ReadonlyMap<string,bigint>;
}

export function buildStaticEffectIndex(
  state:State,
  graph:GraphIndex=buildGraphIndex(state),
):StaticEffectIndex {
  const effectful=Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))
    .flatMap(obligation=>{
      const semantics=effectSemantics(obligation.postcondition);
      return semantics ? [{id:obligation.id,semantics}] : [];
    });

  const byId=new Map<string,IndexedEffect>();
  const byResourceMutable=new Map<string,IndexedEffect[]>();
  const resourceMasks=new Map<string,bigint>();
  const commutingMutable=new Map<string,Map<string,bigint>>();

  for (let index=0;index<effectful.length;index+=1) {
    const effect=effectful[index];
    const bit=1n<<BigInt(index);
    const entry:IndexedEffect={...effect,bit};
    byId.set(entry.id,entry);

    const group=byResourceMutable.get(entry.semantics.resource)??[];
    group.push(entry);
    byResourceMutable.set(entry.semantics.resource,group);
    resourceMasks.set(
      entry.semantics.resource,
      (resourceMasks.get(entry.semantics.resource)??0n)|bit,
    );

    if (entry.semantics.sameDesiredCommutes) {
      const byDesired=commutingMutable.get(entry.semantics.resource)??new Map();
      byDesired.set(
        entry.semantics.desired,
        (byDesired.get(entry.semantics.desired)??0n)|bit,
      );
      commutingMutable.set(entry.semantics.resource,byDesired);
    }
  }

  const ancestors=new Map<string,bigint>();
  for (const id of graph.topologicalOrder) {
    let bits=0n;
    for (const upstream of graph.upstreams.get(id)??[]) {
      bits|=ancestors.get(upstream)??0n;
      bits|=byId.get(upstream)?.bit??0n;
    }
    ancestors.set(id,bits);
  }

  const descendants=new Map<string,bigint>();
  for (const id of [...graph.topologicalOrder].reverse()) {
    let bits=0n;
    for (const downstream of graph.downstreams.get(id)??[]) {
      bits|=descendants.get(downstream)??0n;
      bits|=byId.get(downstream)?.bit??0n;
    }
    descendants.set(id,bits);
  }

  const orderedBitsById=new Map<string,bigint>();
  for (const entry of effectful) {
    orderedBitsById.set(
      entry.id,
      (ancestors.get(entry.id)??0n)|(descendants.get(entry.id)??0n),
    );
  }

  return {
    graph,
    byId,
    byResource:new Map(
      [...byResourceMutable].map(([resource,entries])=>[
        resource,
        entries as readonly IndexedEffect[],
      ]),
    ),
    resourceMasks,
    commutingMasks:new Map(
      [...commutingMutable].map(([resource,byDesired])=>[
        resource,
        byDesired as ReadonlyMap<string,bigint>,
      ]),
    ),
    orderedBitsById,
  };
}

export function staticEffectConflict(
  state:State,
  workId:string,
  index:StaticEffectIndex=buildStaticEffectIndex(state),
):StaticEffectConflict|null {
  if (!state.obligations[workId]) return null;
  const work=index.byId.get(workId);
  if (!work) return null;

  const resource=work.semantics.resource;
  const resourceMask=index.resourceMasks.get(resource)??0n;
  const compatibleMask=work.semantics.sameDesiredCommutes
    ? index.commutingMasks.get(resource)?.get(work.semantics.desired)??0n
    : 0n;
  const incompatibleMask=resourceMask & ~(compatibleMask|work.bit);
  const unorderedMask=incompatibleMask & ~(index.orderedBitsById.get(workId)??0n);
  if (unorderedMask===0n) return null;

  const other=index.byResource.get(resource)
    ?.find(candidate=>(unorderedMask&candidate.bit)!==0n);
  if (!other) throw new Error('STATIC_EFFECT_INDEX_INCONSISTENT');

  const [left,right]=[workId,other.id].sort();
  return {
    left,
    right,
    code:`UNORDERED_EFFECT_CONFLICT:${left}:${right}`,
  };
}

function validateStaticEffectOrdering(
  state:State,
  index:StaticEffectIndex,
):void {
  for (const obligation of Object.values(state.obligations)
    .sort((a,b)=>a.id.localeCompare(b.id))) {
    const conflict=staticEffectConflict(state,obligation.id,index);
    if (conflict) throw new Error(conflict.code);
  }
}

export function validateAdmission(state:State):void {
  const graph=buildGraphIndex(state);
  for (const obligation of Object.values(state.obligations)) {
    settlementSemantics(obligation.postcondition);
  }
  validateSemanticEdges(state);
  validateStaticEffectOrdering(
    state,
    buildStaticEffectIndex(state,graph),
  );
}
