import assert from 'node:assert/strict';

import {
  canonicalTrace,
  causalAncestors,
  enumerateExecutions as enumerateAll,
  type IndependenceOracle,
} from '../partial-order.ts';

import { buildStaticEffectIndex, staticEffectConflict } from '../../src/authority/admission.ts';
import type { State } from '../../src/authority/facts.ts';
import { buildGraphIndex, graphDependsOn } from '../../src/graph/topology.ts';
import type { Dependency, Obligation } from '../../src/model.ts';
import { effectSemantics, effectsConflict } from '../../src/semantics.ts';

interface Event {
  id: string;
  obligation: string;
  resource: string;
  desired: string;
  sameDesiredCommutes: boolean;
  parents: string[];
}

interface ComponentResult {
  ids: string[];
  exhaustive_executions: number;
  trace_classes: number;
}

interface InteractionAnalysis {
  components: string[][];
  interaction_edges: number;
  conflict_edges: number;
  causal_edges: number;
  static_conflict_nodes: number;
}


function prUpdateObligation(
  id: string,
  pullNumber: number,
  dependencies: Dependency[] = [],
): Obligation {
  return {
    id,
    dependencies,
    packet: {},
    postcondition: {
      verifier: 'github-pull-request-branch-updated/v1',
      provider: 'github',
      repository_id: 1,
      repository_full_name: 'example/repo',
      pull_number: pullNumber,
      pull_node_id: 'PR_' + pullNumber,
      expected_previous_head_sha: 'a'.repeat(40),
      base_ref: 'main',
      expected_base_sha: 'b'.repeat(40),
    },
  };
}

function makeBaselineState(): State {
  const obligations: Obligation[] = [];

  for (let index = 0; index < 34; index += 1) {
    obligations.push(prUpdateObligation('solo-' + String(index).padStart(2, '0'), 1_000 + index));
  }

  for (let cluster = 0; cluster < 4; cluster += 1) {
    const label = String.fromCharCode('a'.charCodeAt(0) + cluster);
    for (let member = 0; member < 4; member += 1) {
      obligations.push(prUpdateObligation('cluster-' + label + '-' + member, 2_000 + cluster));
    }
  }

  assert.equal(obligations.length, 50);
  return {
    obligations: Object.fromEntries(obligations.map((obligation) => [obligation.id, obligation])),
    definition_ids: Object.fromEntries(
      obligations.map((obligation) => [obligation.id, 'definition-' + obligation.id]),
    ),
  };
}

function withCausalBridge(state: State): State {
  const copy = structuredClone(state);
  const target = copy.obligations['cluster-b-0'];
  assert.ok(target);
  target.dependencies = [{ kind: 'control', upstream: 'cluster-a-0' }];
  return copy;
}

function pairConflicts(left: Obligation, right: Obligation): boolean {
  const leftSemantics = effectSemantics(left.postcondition);
  const rightSemantics = effectSemantics(right.postcondition);
  if (!leftSemantics || !rightSemantics) return false;
  return effectsConflict(leftSemantics, rightSemantics);
}

function connectedComponents(
  ids: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const unseen = new Set(ids);
  const components: string[][] = [];

  while (unseen.size > 0) {
    const start = [...unseen].sort()[0]!;
    const pending = [start];
    const component: string[] = [];
    unseen.delete(start);

    while (pending.length > 0) {
      const current = pending.pop()!;
      component.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!unseen.has(next)) continue;
        unseen.delete(next);
        pending.push(next);
      }
    }

    components.push(component.sort());
  }

  return components.sort(
    (left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!),
  );
}

function analyzeInteractions(state: State, includeCausality = true): InteractionAnalysis {
  const ids = Object.keys(state.obligations).sort();
  const graph = buildGraphIndex(state);
  const staticIndex = buildStaticEffectIndex(state, graph);
  const adjacency = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  let interactionEdges = 0;
  let conflictEdges = 0;
  let causalEdges = 0;

  for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
      const leftId = ids[leftIndex]!;
      const rightId = ids[rightIndex]!;
      const left = state.obligations[leftId]!;
      const right = state.obligations[rightId]!;
      const conflict = pairConflicts(left, right);
      const causal =
        includeCausality &&
        (graphDependsOn(graph, leftId, rightId) || graphDependsOn(graph, rightId, leftId));

      if (conflict) conflictEdges += 1;
      if (causal) causalEdges += 1;
      if (!conflict && !causal) continue;

      interactionEdges += 1;
      adjacency.get(leftId)!.add(rightId);
      adjacency.get(rightId)!.add(leftId);
    }
  }

  const staticConflictNodes = ids.filter(
    (id) => staticEffectConflict(state, id, staticIndex) !== null,
  ).length;

  return {
    components: connectedComponents(ids, adjacency),
    interaction_edges: interactionEdges,
    conflict_edges: conflictEdges,
    causal_edges: causalEdges,
    static_conflict_nodes: staticConflictNodes,
  };
}

function eventsForComponent(state: State, ids: readonly string[]): Event[] {
  const selected = new Set(ids);
  return ids
    .map((id) => {
      const obligation = state.obligations[id]!;
      const semantics = effectSemantics(obligation.postcondition);
      assert.ok(semantics);
      return {
        id,
        obligation: id,
        resource: semantics.resource,
        desired: semantics.desired,
        sameDesiredCommutes: semantics.sameDesiredCommutes,
        parents: obligation.dependencies
          .map((dependency) => dependency.upstream)
          .filter((upstream) => selected.has(upstream))
          .sort(),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function conservativeOracle(events: readonly Event[]): IndependenceOracle<Event> {
  const ancestors = causalAncestors(events);

  return (left, right) => {
    if (left.id === right.id) return false;
    if (ancestors.get(left.id)?.has(right.id) || ancestors.get(right.id)?.has(left.id)) {
      return false;
    }
    if (left.resource !== right.resource) return true;
    return left.sameDesiredCommutes && right.sameDesiredCommutes && left.desired === right.desired;
  };
}

function analyzeComponent(state: State, ids: readonly string[]): ComponentResult {
  const events = eventsForComponent(state, ids);
  const oracle = conservativeOracle(events);
  const exhaustive = enumerateAll(events);
  const exhaustiveTraces = new Set(
    exhaustive.map((execution) => canonicalTrace(execution, oracle)),
  );

  return {
    ids: [...ids],
    exhaustive_executions: exhaustive.length,
    trace_classes: exhaustiveTraces.size,
  };
}

function factorial(value: number): bigint {
  let result = 1n;
  for (let factor = 2n; factor <= BigInt(value); factor += 1n) result *= factor;
  return result;
}

function summarize(state: State) {
  const interactions = analyzeInteractions(state);
  const components = interactions.components.map((ids) => analyzeComponent(state, ids));
  const localExhaustive = components.reduce(
    (total, component) => total + component.exhaustive_executions,
    0,
  );
  const globalTraceProduct = components.reduce(
    (product, component) => product * BigInt(component.trace_classes),
    1n,
  );

  return {
    interactions,
    components,
    local_exhaustive_executions: localExhaustive,
    global_trace_product: globalTraceProduct,
    max_component_size: Math.max(...components.map((component) => component.ids.length)),
    max_component_trace_classes: Math.max(
      ...components.map((component) => component.trace_classes),
    ),
  };
}

const baselineState = makeBaselineState();
const baseline = summarize(baselineState);
const totalPairs = (50 * 49) / 2;

assert.equal(totalPairs, 1_225);
assert.equal(baseline.interactions.components.length, 38);
assert.deepEqual(
  baseline.interactions.components.map((component) => component.length),
  [4, 4, 4, 4, ...Array(34).fill(1)],
);
assert.equal(baseline.interactions.interaction_edges, 24);
assert.equal(baseline.interactions.conflict_edges, 24);
assert.equal(baseline.interactions.causal_edges, 0);
assert.equal(baseline.interactions.static_conflict_nodes, 16);
assert.equal(baseline.local_exhaustive_executions, 130);
assert.equal(baseline.max_component_size, 4);
assert.equal(baseline.max_component_trace_classes, 24);
assert.equal(baseline.global_trace_product, 331_776n);

const bridgeState = withCausalBridge(baselineState);
const bridge = summarize(bridgeState);
const conflictOnly = analyzeInteractions(bridgeState, false);
const productionGraph = buildGraphIndex(bridgeState);

assert.equal(graphDependsOn(productionGraph, 'cluster-b-0', 'cluster-a-0'), true);
assert.equal(bridge.interactions.components.length, 37);
assert.deepEqual(
  bridge.interactions.components.map((component) => component.length),
  [8, 4, 4, ...Array(34).fill(1)],
);
assert.equal(bridge.interactions.interaction_edges, 25);
assert.equal(bridge.interactions.conflict_edges, 24);
assert.equal(bridge.interactions.causal_edges, 1);
assert.equal(bridge.interactions.static_conflict_nodes, 16);
assert.equal(bridge.local_exhaustive_executions, 20_242);
assert.equal(bridge.max_component_size, 8);
assert.equal(bridge.max_component_trace_classes, 576);
assert.equal(bridge.global_trace_product, 331_776n);

assert.equal(conflictOnly.components.length, 38);
assert.equal(
  conflictOnly.components.some(
    (component) => component.includes('cluster-a-0') && component.includes('cluster-b-0'),
  ),
  false,
);
assert.equal(
  bridge.interactions.components.some(
    (component) => component.includes('cluster-a-0') && component.includes('cluster-b-0'),
  ),
  true,
);

console.log(
  JSON.stringify({
    kind: 'n-agent-interaction-frontier-baseline',
    agents: 50,
    possible_pairs: totalPairs,
    interaction_edges: baseline.interactions.interaction_edges,
    interacting_pair_fraction: baseline.interactions.interaction_edges / totalPairs,
    components: baseline.interactions.components.length,
    component_sizes: baseline.interactions.components.map((component) => component.length),
    static_conflict_nodes: baseline.interactions.static_conflict_nodes,
    full_total_orders: factorial(50).toString(),
    global_trace_product: baseline.global_trace_product.toString(),
    local_exhaustive_executions: baseline.local_exhaustive_executions,
    max_component_size: baseline.max_component_size,
    max_component_trace_classes: baseline.max_component_trace_classes,
  }),
);
console.log(
  JSON.stringify({
    kind: 'n-agent-interaction-frontier-bridge',
    agents: 50,
    possible_pairs: totalPairs,
    interaction_edges: bridge.interactions.interaction_edges,
    conflict_edges: bridge.interactions.conflict_edges,
    causal_edges: bridge.interactions.causal_edges,
    components: bridge.interactions.components.length,
    component_sizes: bridge.interactions.components.map((component) => component.length),
    full_total_orders: factorial(50).toString(),
    global_trace_product: bridge.global_trace_product.toString(),
    local_exhaustive_executions: bridge.local_exhaustive_executions,
    max_component_size: bridge.max_component_size,
    max_component_trace_classes: bridge.max_component_trace_classes,
  }),
);
console.log(
  JSON.stringify({
    kind: 'n-agent-interaction-frontier-negative-control',
    production_dependency_present: true,
    conflict_only_components: conflictOnly.components.length,
    conflict_only_keeps_bridge_apart: true,
    causal_interaction_components: bridge.interactions.components.length,
    causal_interaction_merges_bridge: true,
  }),
);
console.log(
  JSON.stringify({
    kind: 'n-agent-interaction-frontier-summary',
    result: 'supported',
    baseline_agents: 50,
    baseline_possible_pairs: totalPairs,
    baseline_interaction_edges: baseline.interactions.interaction_edges,
    baseline_components: baseline.interactions.components.length,
    bridge_components: bridge.interactions.components.length,
    bridge_max_component_size: bridge.max_component_size,
    conflict_only_negative_control_rejected: true,
  }),
);
