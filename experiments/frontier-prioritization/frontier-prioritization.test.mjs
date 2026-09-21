import test from 'node:test';
import assert from 'node:assert/strict';

const popcount = value => {
  let count = 0;
  for (let bits = value >>> 0; bits; bits &= bits - 1) count += 1;
  return count;
};

const bits = mask => {
  const values = [];
  for (let rest = mask >>> 0; rest; rest &= rest - 1) {
    const bit = rest & -rest;
    values.push(31 - Math.clz32(bit));
  }
  return values;
};

function buildDag(n, edges) {
  const deps = Array(n).fill(0);
  const children = Array(n).fill(0);
  for (const [from, to] of edges) {
    children[from] |= 1 << to;
    deps[to] |= 1 << from;
  }

  const indegree = deps.map(popcount);
  let ready = 0;
  for (let node = 0; node < n; node += 1) if (!indegree[node]) ready |= 1 << node;
  let seen = 0;
  for (let queue = ready; queue;) {
    const bit = queue & -queue;
    queue ^= bit;
    const node = 31 - Math.clz32(bit);
    seen += 1;
    for (const to of bits(children[node])) {
      indegree[to] -= 1;
      if (!indegree[to]) queue |= 1 << to;
    }
  }
  if (seen !== n) return null;

  const descendants = Array(n).fill(0);
  const distance = Array.from({length: n}, () => Array(n).fill(Infinity));
  for (let start = 0; start < n; start += 1) {
    distance[start][start] = 0;
    let frontier = [start];
    for (let depth = 0; frontier.length; depth += 1) {
      const next = [];
      for (const node of frontier) {
        for (const child of bits(children[node])) {
          descendants[start] |= 1 << child;
          if (distance[start][child] === Infinity) {
            distance[start][child] = depth + 1;
            next.push(child);
          }
        }
      }
      frontier = next;
    }
  }
  const ancestors = Array(n).fill(0);
  for (let node = 0; node < n; node += 1) {
    for (let ancestor = 0; ancestor < n; ancestor += 1) {
      if (ancestor === node || descendants[ancestor] & (1 << node)) {
        ancestors[node] |= 1 << ancestor;
      }
    }
  }

  return {n, deps, children, descendants, distance, ancestors};
}

function generateDags(n) {
  const possible = [];
  for (let from = 0; from < n; from += 1) {
    for (let to = 0; to < n; to += 1) if (from !== to) possible.push([from, to]);
  }
  const dags = [];
  for (let encoded = 0; encoded < 2 ** possible.length; encoded += 1) {
    const edges = [];
    for (let index = 0; index < possible.length; index += 1) {
      if (encoded & (1 << index)) edges.push(possible[index]);
    }
    const dag = buildDag(n, edges);
    if (dag) dags.push(dag);
  }
  return dags;
}

const frontierMask = (dag, state) => {
  let frontier = 0;
  for (let node = 0; node < dag.n; node += 1) {
    if (!(state & (1 << node)) && !(dag.deps[node] & ~state)) frontier |= 1 << node;
  }
  return frontier;
};

const complete = (objectiveMasks, state) => objectiveMasks.every(mask => state & mask);

function compileProblem(dag, objectiveMasks) {
  const memo = new Map();
  const cost = state => {
    if (complete(objectiveMasks, state)) return 0;
    if (memo.has(state)) return memo.get(state);
    const frontier = frontierMask(dag, state);
    assert.ok(frontier, 'objective must remain reachable');
    let best = Infinity;
    for (const node of bits(frontier)) best = Math.min(best, 1 + cost(state | (1 << node)));
    memo.set(state, best);
    return best;
  };

  const optimalMask = state => {
    const frontier = frontierMask(dag, state);
    let best = Infinity;
    let optimal = 0;
    for (const node of bits(frontier)) {
      const candidate = 1 + cost(state | (1 << node));
      if (candidate < best) {
        best = candidate;
        optimal = 1 << node;
      } else if (candidate === best) {
        optimal |= 1 << node;
      }
    }
    return optimal;
  };

  return {dag, objectiveMasks, cost, optimalMask, memo};
}

const validState = (dag, state) =>
  Array.from({length: dag.n}, (_, node) => node)
    .every(node => !(state & (1 << node)) || !(dag.deps[node] & ~state));

function closureOracle(problem, state) {
  const {dag, objectiveMasks} = problem;
  const frontier = frontierMask(dag, state);
  const closures = dag.ancestors.map(ancestors => ancestors & ~state);
  const seen = new Set();
  let bestCost = Infinity;
  let optimalFrontier = 0;

  const visit = extra => {
    if (seen.has(extra)) return;
    seen.add(extra);

    const cost = popcount(extra);
    if (cost > bestCost) return;

    const combined = state | extra;
    if (complete(objectiveMasks, combined)) {
      const firstChoices = frontier & extra;
      if (cost < bestCost) {
        bestCost = cost;
        optimalFrontier = firstChoices;
      } else if (cost === bestCost) {
        optimalFrontier |= firstChoices;
      }
      return;
    }

    const unsatisfied = objectiveMasks.filter(mask => !(combined & mask));
    let choices = null;
    for (const objective of unsatisfied) {
      const candidateClosures = [...new Set(bits(objective).map(node => extra | closures[node]))];
      if (choices === null || candidateClosures.length < choices.length) {
        choices = candidateClosures;
      }
    }

    for (const next of choices ?? []) visit(next);
  };

  visit(0);
  return {
    cost: bestCost,
    optimalMask: optimalFrontier,
    exploredStates: seen.size,
  };
}


const bigPopcount = value => {
  let count = 0;
  for (let remaining = value; remaining; remaining &= remaining - 1n) count += 1;
  return count;
};

const bigBitIndexes = mask => {
  const indexes = [];
  for (let remaining = mask; remaining; remaining &= remaining - 1n) {
    const bit = remaining & -remaining;
    indexes.push(bit.toString(2).length - 1);
  }
  return indexes;
};

const compareBigMask = (left, right) =>
  bigPopcount(left) - bigPopcount(right)
  || (left < right ? -1 : left > right ? 1 : 0);

const uniqueBigMasks = values => [...new Set(values)].sort(compareBigMask);

function pruneClosureSupersets(values) {
  const kept = [];
  for (const value of uniqueBigMasks(values)) {
    if (!kept.some(candidate => (candidate & value) === candidate)) kept.push(value);
  }
  return kept;
}

function normalizedClosureObjectives(objectives, selected) {
  const kept = [];
  for (const objective of uniqueBigMasks(objectives.filter(candidate => !(candidate & selected)))) {
    if (!kept.some(candidate => (candidate & objective) === candidate)) kept.push(objective);
  }
  return kept;
}

function closureAlternatives(objective, closures, selected, prune = true) {
  const values = bigBitIndexes(objective).map(node => closures[node] & ~selected);
  return prune ? pruneClosureSupersets(values) : uniqueBigMasks(values);
}

function kernelizeClosureProblem(objectives, closures, selected) {
  let forced = 0n;
  while (true) {
    const combined = selected | forced;
    const unresolved = normalizedClosureObjectives(objectives, combined);
    if (!unresolved.length) return {forced, objectives: []};

    let changed = false;
    for (const objective of unresolved) {
      const alternatives = closureAlternatives(objective, closures, combined);
      if (alternatives.length === 1) {
        forced |= alternatives[0];
        changed = true;
        break;
      }
    }
    if (!changed) return {forced, objectives: unresolved};
  }
}

function closureInteractionComponents(objectives, closures, selected) {
  const unions = objectives.map(objective =>
    closureAlternatives(objective, closures, selected)
      .reduce((union, alternative) => union | alternative, 0n)
  );
  const seen = new Set();
  const components = [];

  for (let start = 0; start < objectives.length; start += 1) {
    if (seen.has(start)) continue;
    const stack = [start];
    const component = [];
    seen.add(start);

    while (stack.length) {
      const current = stack.pop();
      component.push(objectives[current]);
      for (let candidate = 0; candidate < objectives.length; candidate += 1) {
        if (!seen.has(candidate) && (unions[current] & unions[candidate])) {
          seen.add(candidate);
          stack.push(candidate);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function greedyClosureCompletion(objectives, closures, selected) {
  let extra = 0n;
  while (true) {
    const unresolved = normalizedClosureObjectives(objectives, selected | extra);
    if (!unresolved.length) return extra;

    let best = null;
    for (const objective of unresolved) {
      for (const alternative of closureAlternatives(objective, closures, selected | extra)) {
        const cost = bigPopcount(alternative);
        const combined = selected | extra | alternative;
        const gain = unresolved.filter(candidate => candidate & combined).length;
        const ratio = gain / cost;
        if (!best
          || ratio > best.ratio
          || (ratio === best.ratio && gain > best.gain)
          || (ratio === best.ratio && gain === best.gain && cost < best.cost)) {
          best = {alternative, ratio, gain, cost};
        }
      }
    }
    extra |= best.alternative;
  }
}

function packingClosureLowerBound(objectives, closures, selected) {
  const unresolved = normalizedClosureObjectives(objectives, selected);
  const infos = unresolved.map((objective, index) => {
    const alternatives = closureAlternatives(objective, closures, selected);
    return {
      index,
      min: Math.min(...alternatives.map(bigPopcount)),
      union: alternatives.reduce((value, alternative) => value | alternative, 0n),
    };
  });

  for (const info of infos) {
    info.conflicts = infos.filter(other =>
      other.index !== info.index && (other.union & info.union)
    ).length;
  }

  const orders = [
    [...infos].sort((left, right) =>
      right.min - left.min || bigPopcount(left.union) - bigPopcount(right.union)
    ),
    [...infos].sort((left, right) =>
      left.conflicts - right.conflicts || bigPopcount(left.union) - bigPopcount(right.union)
    ),
  ];

  let best = 0;
  for (const order of orders) {
    let used = 0n;
    let bound = 0;
    for (const info of order) {
      if (!(used & info.union)) {
        used |= info.union;
        bound += info.min;
      }
    }
    best = Math.max(best, bound);
  }
  return best;
}

function objectiveCoverageLowerBound(objectives, selected) {
  const unresolved = normalizedClosureObjectives(objectives, selected);
  if (!unresolved.length) return 0;

  let universe = 0n;
  for (const objective of unresolved) universe |= objective;
  const coverage = bigBitIndexes(universe)
    .filter(node => !(selected & (1n << BigInt(node))))
    .map(node => unresolved.filter(objective => objective & (1n << BigInt(node))).length)
    .sort((left, right) => right - left);

  let possible = 0;
  for (let count = 0; count < coverage.length; count += 1) {
    possible += coverage[count];
    if (possible >= unresolved.length) return count + 1;
  }
  return Infinity;
}

const closureLowerBound = (objectives, closures, selected) =>
  Math.max(
    packingClosureLowerBound(objectives, closures, selected),
    objectiveCoverageLowerBound(objectives, selected),
  );

function rawClosureSolve(objectives, closures, selected = 0n, {kernel = false, bounds = false} = {}) {
  let best = bounds
    ? bigPopcount(greedyClosureCompletion(objectives, closures, selected))
    : Infinity;
  const seen = new Set();
  let states = 0;
  let pruned = 0;

  const visit = extra => {
    if (seen.has(extra)) return;
    seen.add(extra);
    states += 1;

    const cost = bigPopcount(extra);
    if (cost > best || (bounds && cost >= best)) {
      pruned += 1;
      return;
    }

    const combined = selected | extra;
    const unresolved = kernel
      ? normalizedClosureObjectives(objectives, combined)
      : objectives.filter(objective => !(objective & combined));

    if (!unresolved.length) {
      best = Math.min(best, cost);
      return;
    }

    if (bounds && cost + closureLowerBound(unresolved, closures, combined) >= best) {
      pruned += 1;
      return;
    }

    let branch = null;
    for (const objective of unresolved) {
      const alternatives = closureAlternatives(objective, closures, combined, kernel);
      if (!branch || alternatives.length < branch.length) branch = alternatives;
    }

    if (bounds) {
      branch = branch
        .map(alternative => {
          const next = combined | alternative;
          return {
            alternative,
            gain: unresolved.filter(objective => objective & next).length,
            cost: bigPopcount(alternative),
          };
        })
        .sort((left, right) =>
          right.gain / right.cost - left.gain / left.cost || left.cost - right.cost
        )
        .map(candidate => candidate.alternative);
    }

    for (const alternative of branch) visit(extra | alternative);
  };

  visit(0n);
  return {cost: best, states, pruned};
}

function exactClosureSolve(
  objectives,
  closures,
  selected = 0n,
  {decompose = true, bounds = true} = {},
) {
  const kernel = kernelizeClosureProblem(objectives, closures, selected);
  const combined = selected | kernel.forced;
  const summary = {
    cost: bigPopcount(kernel.forced),
    states: 0,
    pruned: 0,
    components: 0,
    forced: bigPopcount(kernel.forced),
  };

  if (!kernel.objectives.length) return summary;

  const components = decompose
    ? closureInteractionComponents(kernel.objectives, closures, combined)
    : [kernel.objectives];
  summary.components = components.length;

  for (const component of components) {
    const result = rawClosureSolve(component, closures, combined, {kernel: true, bounds});
    summary.cost += result.cost;
    summary.states += result.states;
    summary.pruned += result.pruned;
  }
  return summary;
}

function exactClosureOracle(problem, state) {
  const objectives = problem.objectiveMasks.map(BigInt);
  const closures = problem.dag.ancestors.map(BigInt);
  const selected = BigInt(state);
  const optimum = exactClosureSolve(objectives, closures, selected);
  let optimalMask = 0;
  let states = optimum.states;

  for (const node of bits(frontierMask(problem.dag, state))) {
    const forced = exactClosureSolve(
      objectives,
      closures,
      selected | (1n << BigInt(node)),
    );
    states += forced.states;
    if (1 + forced.cost === optimum.cost) optimalMask |= 1 << node;
  }

  return {cost: optimum.cost, optimalMask, exploredStates: states};
}

function closureSolverLadder(objectives, closures) {
  return {
    raw: rawClosureSolve(objectives, closures),
    kernel: rawClosureSolve(objectives, closures, 0n, {kernel: true}),
    decomposed: exactClosureSolve(objectives, closures, 0n, {bounds: false}),
    bounded: exactClosureSolve(objectives, closures),
  };
}

const unitClosures = count =>
  Array.from({length: count}, (_, node) => 1n << BigInt(node));

function dominatedClosureCase(count) {
  const closures = [];
  const objectives = [];
  for (let index = 0; index < count; index += 1) {
    const prerequisite = 1n << BigInt(2 * index);
    const dependent = 1n << BigInt(2 * index + 1);
    closures.push(prerequisite, prerequisite | dependent);
    objectives.push(prerequisite | dependent);
  }
  return {objectives, closures};
}

function independentClosureCase(count, alternatives = 2) {
  const closures = unitClosures(count * alternatives);
  const objectives = Array.from({length: count}, (_, objective) => {
    let mask = 0n;
    for (let alternative = 0; alternative < alternatives; alternative += 1) {
      mask |= 1n << BigInt(objective * alternatives + alternative);
    }
    return mask;
  });
  return {objectives, closures};
}

function cycleClosureCase(count) {
  const closures = unitClosures(count);
  const objectives = Array.from({length: count}, (_, objective) =>
    (1n << BigInt(objective))
    | (1n << BigInt((objective + 1) % count))
  );
  return {objectives, closures};
}

function randomHittingClosureCase(nodes, objectiveCount, probability, seed) {
  const random = new XorShift32(seed);
  const closures = unitClosures(nodes);
  const objectives = [];

  for (let objective = 0; objective < objectiveCount; objective += 1) {
    let mask = 0n;
    while (!mask) {
      for (let node = 0; node < nodes; node += 1) {
        if (random.fraction() < probability) mask |= 1n << BigInt(node);
      }
    }
    objectives.push(mask);
  }
  return {objectives, closures};
}

function structuralFacts(problem, state, node) {
  const {dag, objectiveMasks} = problem;
  const frontier = frontierMask(dag, state);
  const unsatisfied = objectiveMasks.filter(mask => !(state & mask));
  const reachable = (1 << node) | dag.descendants[node];

  let mandatoryObjectives = 0;
  let directObjectives = 0;
  let reachableObjectives = 0;
  let immediateObjectiveUnlocks = 0;
  const distances = [];

  for (const objective of unsatisfied) {
    if (!(objective & reachable)) continue;
    reachableObjectives += 1;
    if (objective & (1 << node)) directObjectives += 1;
    const frontierRoutes = bits(frontier).filter(candidate =>
      objective & ((1 << candidate) | dag.descendants[candidate])
    ).length;
    if (frontierRoutes === 1) mandatoryObjectives += 1;

    let nearest = Infinity;
    for (const satisfier of bits(objective)) {
      nearest = Math.min(nearest, dag.distance[node][satisfier]);
    }
    distances.push(nearest);
  }

  const nextState = state | (1 << node);
  const newlyAdmitted = frontierMask(dag, nextState) & ~frontier;
  for (const candidate of bits(newlyAdmitted)) {
    if (unsatisfied.some(objective => objective & (1 << candidate))) {
      immediateObjectiveUnlocks += 1;
    }
  }

  return {
    mandatoryObjectives,
    directObjectives,
    reachableObjectives,
    immediateObjectiveUnlocks,
    nearestObjective: distances.length ? Math.min(...distances) : Infinity,
    totalObjectiveDistance: distances.length
      ? distances.reduce((sum, distance) => sum + distance, 0)
      : Infinity,
  };
}

function priorityTuple(problem, state, node, stage) {
  const facts = structuralFacts(problem, state, node);
  if (stage === 'reachability') return [facts.reachableObjectives];
  const base = [
    facts.mandatoryObjectives,
    facts.directObjectives,
    facts.reachableObjectives,
  ];
  if (stage === 'unlock') base.push(facts.immediateObjectiveUnlocks);
  return [
    ...base,
    -facts.nearestObjective,
    -facts.totalObjectiveDistance,
  ];
}

function compareTuple(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function preferredMask(problem, state, stage) {
  const frontier = frontierMask(problem.dag, state);
  let bestTuple = null;
  let preferred = 0;
  for (const node of bits(frontier)) {
    const tuple = priorityTuple(problem, state, node, stage);
    const comparison = bestTuple === null ? 1 : compareTuple(tuple, bestTuple);
    if (comparison > 0) {
      bestTuple = tuple;
      preferred = 1 << node;
    } else if (comparison === 0) {
      preferred |= 1 << node;
    }
  }
  return preferred;
}

function emptyClassification() {
  return {states: 0, equivalent: 0, resolved: 0, ambiguous: 0, wrong: 0};
}

function classifyProblem(problem, stage) {
  const summary = emptyClassification();
  for (let state = 0; state < 1 << problem.dag.n; state += 1) {
    if (!validState(problem.dag, state)) continue;
    if (complete(problem.objectiveMasks, state)) continue;
    const frontier = frontierMask(problem.dag, state);
    if (popcount(frontier) < 2) continue;
    summary.states += 1;

    const optimal = problem.optimalMask(state);
    if (optimal === frontier) {
      summary.equivalent += 1;
      continue;
    }

    const preferred = preferredMask(problem, state, stage);
    if (!(preferred & ~optimal)) summary.resolved += 1;
    else if (popcount(preferred) > 1) summary.ambiguous += 1;
    else summary.wrong += 1;
  }
  return summary;
}

function addClassification(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
  return target;
}

function evaluateExhaustiveFamily(n, objectiveCount, stage) {
  const dags = generateDags(n);
  const masks = Array.from({length: (1 << n) - 1}, (_, index) => index + 1);
  const summary = emptyClassification();

  const visit = (dag, depth, objectives) => {
    if (depth === objectiveCount) {
      return void addClassification(summary, classifyProblem(compileProblem(dag, objectives), stage));
    }
    for (const mask of masks) visit(dag, depth + 1, [...objectives, mask]);
  };

  for (const dag of dags) visit(dag, 0, []);
  return {dags: dags.length, summary};
}

class XorShift32 {
  constructor(seed) { this.state = seed >>> 0; }
  uint32() {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }
  fraction() { return this.uint32() / 2 ** 32; }
  shuffle(values) {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(this.fraction() * (index + 1));
      [values[index], values[swap]] = [values[swap], values[index]];
    }
  }
}

function sampledDag(n, density, random) {
  const order = Array.from({length: n}, (_, index) => index);
  random.shuffle(order);
  const edges = [];
  for (let from = 0; from < n; from += 1) {
    for (let to = from + 1; to < n; to += 1) {
      if (random.fraction() < density) edges.push([order[from], order[to]]);
    }
  }
  return buildDag(n, edges);
}

function sampledObjectives(n, count, random) {
  const objectives = [];
  for (let objective = 0; objective < count; objective += 1) {
    let mask = 0;
    while (!mask) {
      for (let node = 0; node < n; node += 1) {
        if (random.fraction() < 0.3) mask |= 1 << node;
      }
    }
    objectives.push(mask);
  }
  return objectives;
}

function evaluateLargerSample() {
  const random = new XorShift32(0xC0FFEE);
  const summary = emptyClassification();
  let problems = 0;
  let verifierResiduals = 0;
  let verifierExploredStates = 0;
  let verifierMaxStates = 0;

  for (let n = 5; n <= 10; n += 1) {
    for (let sample = 0; sample < 200; sample += 1) {
      const density = [0.15, 0.30, 0.50][sample % 3];
      const dag = sampledDag(n, density, random);
      const objectives = sampledObjectives(n, 1 + (sample % 3), random);
      const problem = compileProblem(dag, objectives);

      for (let state = 0; state < 1 << n; state += 1) {
        if (!validState(dag, state) || complete(objectives, state)) continue;
        const frontier = frontierMask(dag, state);
        if (popcount(frontier) < 2) continue;
        summary.states += 1;

        const optimal = problem.optimalMask(state);
        if (optimal === frontier) {
          summary.equivalent += 1;
          continue;
        }

        const preferred = preferredMask(problem, state, 'unlock');
        if (!(preferred & ~optimal)) {
          summary.resolved += 1;
          continue;
        }

        if (popcount(preferred) > 1) summary.ambiguous += 1;
        else summary.wrong += 1;

        const verified = closureOracle(problem, state);
        assert.equal(verified.cost, problem.cost(state));
        assert.equal(verified.optimalMask, optimal);
        verifierResiduals += 1;
        verifierExploredStates += verified.exploredStates;
        verifierMaxStates = Math.max(verifierMaxStates, verified.exploredStates);
      }

      problems += 1;
    }
  }

  return {
    problems,
    summary,
    verifierResiduals,
    verifierExploredStates,
    verifierMaxStates,
  };
}

function buildIndependentObjectiveProblem(objectives, alternatives) {
  const n = objectives * alternatives;
  const dag = buildDag(n, []);
  const objectiveMasks = Array.from({length: objectives}, (_, objective) => {
    let mask = 0;
    for (let alternative = 0; alternative < alternatives; alternative += 1) {
      mask |= 1 << (objective * alternatives + alternative);
    }
    return mask;
  });
  return compileProblem(dag, objectiveMasks);
}

function buildChainProblem(depth, distractors = 0) {
  const n = depth + distractors;
  const edges = Array.from({length: Math.max(0, depth - 1)}, (_, index) => [index, index + 1]);
  return compileProblem(buildDag(n, edges), [1 << (depth - 1)]);
}

test('feature ladder removes all apparent ambiguity in the exhaustive small frontier corpus', () => {
  const expected = {
    reachability: {states: 7_395, equivalent: 2_389, resolved: 3_458, ambiguous: 1_548, wrong: 0},
    distance: {states: 7_395, equivalent: 2_389, resolved: 4_934, ambiguous: 72, wrong: 0},
    unlock: {states: 7_395, equivalent: 2_389, resolved: 5_006, ambiguous: 0, wrong: 0},
  };

  for (const stage of Object.keys(expected)) {
    const oneObjective = evaluateExhaustiveFamily(4, 1, stage);
    const twoObjectives = evaluateExhaustiveFamily(3, 2, stage);
    assert.equal(oneObjective.dags, 543);
    assert.equal(twoObjectives.dags, 25);
    const total = addClassification(emptyClassification(), oneObjective.summary);
    addClassification(total, twoObjectives.summary);
    assert.deepEqual(total, expected[stage]);
  }
});

test('closure verifier certifies every larger-sample heuristic residual cheaply', () => {
  const sample = evaluateLargerSample();
  assert.equal(sample.problems, 1_200);
  assert.deepEqual(sample.summary, {
    states: 15_574,
    equivalent: 1_814,
    resolved: 13_648,
    ambiguous: 53,
    wrong: 59,
  });

  const heuristicEquivalent = sample.summary.equivalent + sample.summary.resolved;
  assert.ok(heuristicEquivalent / sample.summary.states > 0.992);
  assert.equal(sample.verifierResiduals, 112);
  assert.equal(sample.verifierExploredStates, 416);
  assert.equal(sample.verifierMaxStates, 7);
});

test('closure verifier exactly matches subset-state oracle on the exhaustive reachable corpus', () => {
  for (const [n, objectiveCount] of [[4, 1], [3, 2]]) {
    const masks = Array.from({length: (1 << n) - 1}, (_, index) => index + 1);
    for (const dag of generateDags(n)) {
      const visitObjectives = (depth, objectives) => {
        if (depth < objectiveCount) {
          for (const mask of masks) visitObjectives(depth + 1, [...objectives, mask]);
          return;
        }
        const problem = compileProblem(dag, objectives);
        for (let state = 0; state < 1 << n; state += 1) {
          if (!validState(dag, state) || complete(objectives, state)) continue;
          const verified = closureOracle(problem, state);
          assert.equal(verified.cost, problem.cost(state));
          assert.equal(verified.optimalMask, problem.optimalMask(state));
          const optimized = exactClosureOracle(problem, state);
          assert.equal(optimized.cost, problem.cost(state));
          assert.equal(optimized.optimalMask, problem.optimalMask(state));
        }
      };
      visitObjectives(0, []);
    }
  }
});


test('solver ladder removes avoidable combinatorics before exact search becomes expensive', () => {
  const dominatedCase = dominatedClosureCase(12);
  const dominated = closureSolverLadder(dominatedCase.objectives, dominatedCase.closures);
  assert.deepEqual(
    Object.fromEntries(Object.entries(dominated).map(([stage, result]) => [stage, result.states])),
    {raw: 1217, kernel: 13, decomposed: 0, bounded: 0},
  );

  const independent = independentClosureCase(12);
  const independentLadder = closureSolverLadder(independent.objectives, independent.closures);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(independentLadder).map(([stage, result]) => [stage, result.states])
    ),
    {raw: 8191, kernel: 8191, decomposed: 36, bounded: 12},
  );

  const cycle = cycleClosureCase(20);
  const cycleLadder = closureSolverLadder(cycle.objectives, cycle.closures);
  assert.deepEqual(
    Object.fromEntries(Object.entries(cycleLadder).map(([stage, result]) => [stage, result.states])),
    {raw: 7714, kernel: 7676, decomposed: 7676, bounded: 1},
  );
});

test('optimized exact solver scales with interaction rather than raw node count', () => {
  const wide = independentClosureCase(100);
  const wideResult = exactClosureSolve(wide.objectives, wide.closures);
  assert.equal(wideResult.cost, 100);
  assert.equal(wideResult.components, 100);
  assert.equal(wideResult.states, 100);

  const interacting = randomHittingClosureCase(80, 50, 0.06, 9);
  const interactingResult = exactClosureSolve(interacting.objectives, interacting.closures);
  assert.equal(interactingResult.cost, 13);
  assert.equal(interactingResult.components, 1);
  assert.equal(interactingResult.states, 248);
});

test(
  'optional connected stress boundary remains exact',
  {skip: process.env.OVERCENTER_FRONTIER_STRESS !== '1'},
  () => {
    const stressCase = randomHittingClosureCase(100, 60, 0.05, 35);
    const result = exactClosureSolve(stressCase.objectives, stressCase.closures);
    assert.equal(result.cost, 16);
    assert.equal(result.components, 1);
    assert.equal(result.states, 16_797);
  },
);

test('verifier complexity follows objective alternatives rather than irrelevant node count', () => {
  const width = [0, 4, 8, 16, 24].map(distractors =>
    closureOracle(buildChainProblem(2, distractors), 0).exploredStates
  );
  const depth = [1, 2, 4, 8, 16, 24].map(length =>
    closureOracle(buildChainProblem(length), 0).exploredStates
  );
  const objectiveBranching = Array.from({length: 10}, (_, index) => index + 1).map(objectives =>
    closureOracle(buildIndependentObjectiveProblem(objectives, 2), 0).exploredStates
  );

  assert.deepEqual(width, [2, 2, 2, 2, 2]);
  assert.deepEqual(depth, [2, 2, 2, 2, 2, 2]);
  assert.deepEqual(objectiveBranching, [3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047]);
});
