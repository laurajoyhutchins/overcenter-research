# N-agent interaction frontier

## Question

Can Overcenter mechanically reduce a 50-agent proposal set to the small connected regions that actually require joint reasoning, using production graph causality and production provider-effect semantics rather than treating every agent pair as potentially coupled?

This experiment stacks on the causal quotient and DPOR race/backtracking treatments.

## Preregistered workload

Fifty obligations represent fifty agent proposals.

- **34** proposals target unique GitHub pull-request branch resources.
- **16** proposals form four 4-agent conflict islands. Every proposal inside one island targets the same canonical pull-request branch resource, whose production effect semantics do not commute even for identical desired writes.
- There are **1,225** possible agent pairs.

The baseline has no graph dependencies between islands.

The hostile treatment adds one real control dependency from `cluster-b-0` to `cluster-a-0`. The provider resources remain disjoint across those two islands, so a conflict-only analyzer would miss the coupling.

## Machinery under test

The interaction graph uses two deterministic relations:

1. production graph causality via `buildGraphIndex()` / `graphDependsOn()`;
2. production effect resource and commutativity semantics via `effectSemantics()`.

Connected components define the smallest regions that may need joint execution-order reasoning.

Each component is independently checked with the race/backtracking explorer against exhaustive enumeration. Components are not cross-product-enumerated for component-local properties.

## Baseline expectations

The four 4-agent conflict islands contribute six pair edges each:

```text
4 * C(4,2) = 24 interaction edges
```

The other 34 obligations are singleton components.

Expected baseline:

- 38 connected components;
- component sizes `4,4,4,4,1...1`;
- 24 interacting pairs out of 1,225 possible pairs;
- 16 nodes reported by production static conflict analysis;
- 130 component-local exhaustive/reduced executions: `4 * 4! + 34`;
- maximum component width 4;
- 331,776 combined causal trace classes: `(4!)^4`.

The global total-order space is still `50!`; the experiment must never attempt to enumerate it.

## Causal-bridge treatment

Add:

```text
cluster-a-0 -> cluster-b-0
```

Production causality must merge the two otherwise disjoint conflict islands.

Expected treatment:

- 37 connected components;
- component sizes `8,4,4,1...1`;
- 25 interaction edges: 24 provider conflicts plus one causal edge;
- the bridged 8-agent component has 576 causal trace classes;
- race/backtracking explores exactly those 576 classes rather than its 20,160 concrete topological schedules;
- total component-local reduced work rises from 130 to 658 executions.

This increase is intentional: once a real dependency bridges two islands, reasoning about them separately is no longer sound.

## Negative control

A deliberately incomplete analyzer using **provider conflicts only** must leave the two bridged islands separate even though production `graphDependsOn()` proves the dependency.

The experiment is falsified if conflict-only decomposition and causal interaction decomposition produce the same frontier after the bridge.

## Acceptance criteria

The treatment is supported only if:

1. the baseline contains exactly 50 obligations and 1,225 possible pairs;
2. production semantics derive exactly 24 interaction edges and 38 components in the baseline;
3. the baseline component sizes are four groups of four plus 34 singletons;
4. production static conflict analysis identifies exactly the 16 clustered nodes;
5. component-local exhaustive and race/backtracking analyses agree on every component;
6. baseline local exploration requires exactly 130 complete executions and the combined trace product is 331,776;
7. the production control dependency merges two 4-agent islands into one 8-agent component;
8. the bridged component has exactly 576 causal trace classes and race/backtracking representatives;
9. total bridged local reduced work is exactly 658 executions;
10. conflict-only decomposition misses the causal bridge and is rejected by comparison with production graph causality.

## Reproduce

```sh
npm run experiment:n-agent-interaction-frontier
```

Hosted exact-head execution is in `.github/workflows/n-agent-interaction-frontier.yml`.

## Interpretation boundary

A positive result would support an Overcenter planning primitive that computes an **interaction frontier** before asking agents or a model to reason jointly about N-way work. Independent components can remain independent; causal or effect-conflict bridges expand the frontier deterministically.

## Non-claims

- Every real code change exposes complete provider-style effect semantics.
- File-level or semantic code conflicts are solved by this fixture.
- Component-local verification is sufficient for arbitrary global properties.
- 50-agent execution throughput is measured.
- Fair scheduling across 50 live workers is proved.
- Distributed authority or HA is established.
- The 50-agent global trace product should be enumerated in production.


## Exact-head result

Supported at exact treatment revision `d9f2be76f0143d4049744ffa4985ac71f45f2c04`.

GitHub Actions run `35951393837`, job `107480499860`, passed the preregistered treatment.

### Baseline

| Measure | Result |
| --- | ---: |
| Agent proposals | 50 |
| Possible agent pairs | 1,225 |
| Actual interaction edges | 24 |
| Interacting pair fraction | 1.96% |
| Connected components | 38 |
| Static-conflict nodes | 16 |
| Component-local complete executions | 130 |
| Component-local explored prefixes | 328 |
| Maximum component size | 4 |
| Maximum component trace classes | 24 |
| Combined causal trace product | 331,776 |
| Naive global total orders | 50! = 30,414,093,201,713,378,043,612,608,166,064,768,844,377,641,568,960,512,000,000,000,000 |

The baseline therefore reduced the pairwise interaction surface from 1,225 possible pairs to 24 actual edges, four 4-agent conflict islands, and 34 singleton proposals.

### Causal bridge

Adding one production control dependency between two otherwise separate conflict islands produced:

| Measure | Result |
| --- | ---: |
| Interaction edges | 25 |
| Provider-conflict edges | 24 |
| Causal edges | 1 |
| Connected components | 37 |
| Largest component | 8 agents |
| Largest component trace classes | 576 |
| Component-local exhaustive executions | 20,242 |
| Component-local race/backtracking executions | 658 |
| Component-local explored prefixes | 1,799 |

The global trace product remained 331,776, but the local reasoning frontier expanded materially because the real causal edge merged two islands. The 8-agent component's 20,160 concrete topological schedules reduced to 576 causal representatives.

The negative control behaved as required: provider-conflict-only decomposition still reported 38 components and kept the two islands separate, while production graph causality reported 37 components and merged them.

### Interpretation

The evidence supports a deterministic **interaction frontier** as a useful N-agent planning primitive. For component-local questions, Overcenter does not need to ask a model to jointly reason over every agent pair or enumerate the 50-agent total-order space. It can derive the small coupled regions from authority-visible graph and effect semantics first.

The bridge result is equally important: the partition is not merely a resource bucketization heuristic. A real graph dependency expands the frontier even when provider resources differ.
