# Archived experiment findings

These are **historical findings**, not maintained executable experiments. They are retained because the conclusion still constrains current design, while the old implementation stack no longer earns ongoing maintenance.

For maintained experiments, use `experiments/registry.json`.

## Categorical graph laws

Source: PR #98, exact experimental head `1e8c6eb719b8b8b53993463e964a5c54e8cc5c3c`.

The experiment rejected the strongest “graph semantics factor only through reachability” story. A three-node counterexample showed that adding a transitive control edge can change execution eligibility after an upstream amendment even when reachability is unchanged.

Two bounded laws did survive:

- subdividing a control edge preserved original-obligation semantic identity in all 6,193 tested subdivisions over 4,165 typed graphs;
- disjoint-union projection preserved per-obligation status, semantic key, claimability, and explanation across 3,025 tested component pairs.

The global ready-work choice intentionally did not decompose. The useful conclusion is therefore that different Overcenter surfaces forget different graph structure; there is no single monolithic reachability-poset semantics.

The executable branch is archived rather than maintained because these laws are informative but do not currently justify their own permanent test surface.

## Lean runtime authority deletion

Source: PR #115, exact experimental head `391a8711050373ba1fbf4c5b78b92ce2fe15f806`.

A drop-in per-validation Lean subprocess was tested as a possible replacement for current TypeScript graph-validity authority during historical replay. The frozen budget allowed at most 500 ms of added replay cost over 100 historical definition prefixes.

Two runs measured:

| Runtime | Run 1 | Run 2 |
| --- | ---: | ---: |
| TypeScript replay | 14.522 ms | 14.711 ms |
| Lean one-shot replay | 3,721.874 ms | 3,805.783 ms |
| Added one-shot cost | 3,707.352 ms | 3,791.072 ms |
| Lean persistent replay | 82.171 ms | 79.425 ms |

Behavioral parity held for valid prefixes, and both implementations failed closed for unknown dependencies and cycles.

The result rejects a per-decision subprocess boundary for production authority deletion. It does **not** reject Lean as a semantic reference/proof oracle, which is the narrower role retained on current `main`.

## Indexed Lean admission performance

Source: PR #113, experimental lineage head `0c5db60f2dc14af93f554fd9f870181261ce5f11`; final measured executable revision `3e438674551a6df487821e124f64e86bf30ebf06`.

After replacing repeated membership/reachability work with indexed lookup and topological traversal, three exact-revision replications at 1,000 obligations measured one-shot p95 of 46.442–49.347 ms and persistent p95 of 3.579–3.735 ms, under the experiment's frozen ceilings.

The effect-order optimization also passed 40,960 optimized-vs-reference comparisons over all 1,024 DAGs compatible with the five-node labeling used by the experiment.

This demonstrates that the semantic computation can be made cheap. It does not erase the architectural cost identified by the authority-deletion experiment, and it does not justify moving persistence, provider I/O, scheduling, mutation authority, credentials, or general orchestration into Lean.

## Disposition of the old draft stacks

The long Lean integration stack (#53, #68, #71, #76, #79, #83, #92, #113, #115) is intentionally not maintained as a chain of open PRs. Current `main` retains the earned Lean role as a semantic reference/proof oracle; the historical performance and negative integration results above remain available for future boundary decisions.

The old producer-independent-realization stack (#46, #48, #50, #51, #117) is also not carried forward wholesale. The narrow pure semantic slice from #117 is being replayed independently on current `main`; the older Git-kernel lifecycle/materialization stack remains historical evidence only.
