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

## Settlement equivalence is narrower than provider-history equivalence

Source: PR #70, exact live-proof revision `f45f246148193285f3cc6df98c2b5ae5b9e8402f`; evidence workflow `35425026839`; live GitHub workflow `35425026792`.

Real GitHub commit-status writes to one exact coordinate produced distinct provider records while deriving the same Overcenter truth for same-state writes in both sequential orders and under concurrency:

```text
A(success) -> B(success)   => present / success / verified
B(success) -> A(success)   => present / success / verified
A(success) || B(success)   => present / success / verified
```

The hostile mixed-state control remained order-sensitive: `success -> failure` failed expected-success verification, while `failure -> success` passed it.

The durable rule is therefore **settlement equivalence**, not generic effect commutativity or physical provider-history equivalence. Unordered same-resource execution is justified only when the exact provider, coordinate, observation contract, mutation contract, and settlement semantics derive the same project truth. Distinct descriptions, target URLs, retained provider records, or future provider behavior are outside that claim. Cross-contract or cross-version equivalence must fail closed unless an explicit bridge is independently justified.

The old witness implementation stack is not retained merely to preserve this conclusion.

## Mutation authority must be explicit and pre-bound

Source: PR #96, exact red-team head `1abc84efd8d8aa1fed3ea1c50579865b2849a1da`; evidence workflow `35430650428`.

Four passing counterexamples broke the first `effect-ready` design:

1. binding a TaskSession after worker execution let an old signal inherit newer authority after generation rotation;
2. a mutation-capable provider effect could be derived from an observation-only postcondition with no explicit mutation grant;
3. a bare worker readiness assertion could trigger mutation without accepted realization evidence;
4. the generic effectful core loop bypassed the newer broker boundary entirely.

The durable architectural constraints are correspondingly strict:

- trusted dispatch binds the worker to its immutable execution session before untrusted work begins;
- observation authority is not mutation authority;
- worker output is evidence to verify, never the authority-bearing transition guard;
- consequential effects require explicit versioned effect authority, deterministic result acceptance when applicable, exact effect identity, durable reservation, and a trusted broker;
- there must not be a second generic effect path around that boundary.

PR #101 merged the repair: pre-bound TaskSessions, explicit identity-bound effect authority, deterministic accepted realizations, pinned adapter identity, exact-effect reservations, and removal of the generic arbitrary-effect callback. The red-team branch is retained as historical evidence for why those constraints exist, not as a maintained implementation.

## Positive combined readback materially reduced GitHub latency

Source: PR #198, measured source revision `c823527f59e0b451fe1a0fe22a67418e9576994b`; GitHub Actions run `35570657393`; four paired live samples.

The candidate reused persistent Node transport and settled successful commit-status writes from one combined-status response while still binding repository ID/name, exact SHA, normalized context, status identity, and expected state.

| Variant | identity median ms | mutation median ms | readback median ms | total median ms |
| --- | ---: | ---: | ---: | ---: |
| prior production pattern | 357.979 | 659.897 | 720.943 | 1,755.522 |
| persistent fetch + combined readback | 245.019 | 863.112 | 224.592 | 1,323.419 |

The candidate was faster in all four paired comparisons. Median total provider time fell **24.614%**; identity lookup fell **31.6%**; settlement readback fell **68.8%**.

The important semantic boundary survived the performance win: one combined-status page can certify a matching positive observation, but it cannot establish authoritative absence. Missing-target cases still require the stronger paginated/continuity-aware observation path.

This result graduated rather than remaining an experiment. PR #202 merged the certified positive combined-status readback, and PR #214 merged persistent async GitHub transport while preserving the fail-closed absence boundary.

## Reasoning transport may vary without moving project authority

Source: PR #210. Successful live proof at exact revision `ddb16ae6e077131da5d4fe0ca1a3ca63a3ed27ca`, workflow run `35649591651`, evidence artifact `10661906036` with ZIP SHA-256 `680f7847fd6cb538d64904929c8ae119f28770b7fa2ae4b314a2fc2215c025cc`.

The experiment put AI Gateway and direct Google inference behind one reasoning-selection seam while keeping provider-specific routing outside Overcenter's authority logic. The direct-Google path used a separately fenced GitHub OIDC/WIF identity, a narrow key-reader role, and a billing-disabled Gemini project; the retrieved API key was ephemeral to the inference process rather than stored in GitHub, source, Secret Manager, or retained evidence.

The successful run demonstrated one useful Stage 1 candidate with:

- reasoning-provider and funding-route changes isolated from project truth;
- no repository credential, readable checkout, Overcenter authority database, or project-provider mutation authority in the reasoning process;
- candidate bytes treated as untrusted input and independently verified before settlement;
- fresh reconstruction after settlement;
- no claim that online Gemini inference was physically offline or network-confined.

The durable boundary is that **reasoning transport is replaceable; authority topology is not**. A free-tier route can be an operational escape hatch, but quota, availability, and sustained capacity are not semantic guarantees and must not become liveness or correctness assumptions. A single successful free-tier run proves the route can work, not that it is dependable capacity. Unknown routing profiles should fail closed.

The old Google-free bootstrap/workflow stack is therefore historical evidence, not a required production dependency.

## Disposition of the old draft stacks

The long Lean integration stack (#53, #68, #71, #76, #79, #83, #92, #113, #115) is intentionally not maintained as a chain of open PRs. Current `main` retains the earned Lean role as a semantic reference/proof oracle; the historical performance and negative integration results above remain available for future boundary decisions.

The old producer-independent-realization stack (#46, #48, #50, #51, #117) is also not carried forward wholesale. The narrow pure semantic slice from #117 is being replayed independently on current `main`; the older Git-kernel lifecycle/materialization stack remains historical evidence only.

PRs #70, #96, #198, and #210 are likewise archival sources after the conclusions above are retained here. Their stale implementation branches should not remain open merely as documentation.
