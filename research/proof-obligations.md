# Proof obligations

Overcenter's evidence surface should answer a stricter question than "are the tests green?":

> Which claim is being exercised, at which layer, and what does a green result actually establish?

The evidence classes remain deliberately separate. The first three are continuously enforced by `.github/workflows/tests.yml` on pull requests and `main`; the Lean semantic-oracle differential is retained as historical exact-revision evidence; the live provider lane remains separately dispatchable:

- `npm test` — deterministic implementation invariants;
- `npm run proof:local` — adversarial executable experiments;
- `npm run proof:formal` — model-checked safety properties and negative controls;
- historical Lean semantic-oracle witness at `766f581c1592f7f3193b95b3d18f47f7c5b22234` — bounded exhaustive differential against exact pinned Lean revision `39bd16a317bc2155a17b6674a5050adaf4295c90`;
- `npm run proof:live` — real GitHub provider proofs at one exact source revision.

A claim is not promoted merely because an adjacent evidence class is green.

## Current obligation map

| Obligation | Implementation | Local adversarial | Formal | Live provider | Current boundary |
| --- | --- | --- | --- | --- | --- |
| Projection is reconstructed from durable facts rather than a privileged lifecycle snapshot. | `test/projection-pure.test.ts`, `test/projection-reconstruction.test.ts` | disposable-agent reconstruction | — | disposable-agent proof | Demonstrated for the Git prototype. |
| A claim is bound to the exact authority revision and semantic obligation identity. | `test/git-kernel.test.ts`, `test/dependency-edge-adversarial.test.ts` | CAS contention | `ExactRevisionEvidence` | disposable-agent proof | Demonstrated for Git authority; lease-generation fencing is separate. |
| Realization state is distinct from execution eligibility. | `test/lifecycle-pure.test.ts`, `test/graph-pure.test.ts` | conflict projection | — | — | Demonstrated for the current graph/projection mechanism. |
| Production graph validity and normalized effect ordering matched the Lean semantic reference at the evaluated revision. | `src/graph/topology.ts`, `src/authority/admission.ts`, `src/semantics.ts` | Historical exact-revision differential at `766f581c1592f7f3193b95b3d18f47f7c5b22234`: 8,192 directed four-node graph/dependency-kind comparisons plus 8 hostile/mixed graph cases, and 245,768 effect-order comparisons | graph acyclicity soundness is proved in pinned Lean oracle revision `39bd16a317bc2155a17b6674a5050adaf4295c90`; effect ordering has bounded differential evidence, not universal equivalence | — | GitHub Actions run `35801357388`, job `106992185603`, passed at `766f581c1592f7f3193b95b3d18f47f7c5b22234`. The executable oracle remains reproducible from that revision but is not continuously run on current `main`. Provider-specific effect normalization remains TypeScript semantics. |
| Semantic dependencies invalidate or reuse downstream work according to selected upstream identity. | `test/dependency-edge-adversarial.test.ts` | — | — | — | Demonstrated for the implemented selectors, not a general realization cache. |
| Worker-local or ambient worker capability cannot manufacture project truth without trusted observation and settlement. | kernel regression | disposable-agent + ambient-authority-boundary experiments | — | ambient-authority workflow run `35773715692` at exact revision `8b12eb1f4da309223af2b255eb1f59389dffda8a` | Authority confinement demonstrated even when the deliberately over-capable worker successfully performed the GitHub status mutation: provider write returned HTTP 201, authority remained `EXECUTING`, and separate trusted recovery settled `DONE`. |
| A worker can be physically prevented from undelegated effects only when the substrate supplies an independently established capability boundary. | Rust confinement contracts; GitHub Actions job permissions | hostile Rust confinement proof + disposable-agent experiment | resource-containment model covers resource authority, not arbitrary host-tool capabilities | disposable-agent workflow run `35389453056` at exact revision `f8a883d6214d76b0b609eb05e3798d6238d108cc`; ambient-authority run `35773715692` is the negative control | Effect confinement is demonstrated for the supported Rust child-process boundary and the ordinary GitHub worker permission boundary. The over-capable hosted arm proves it must not be generalized to uncontrolled parent-agent capabilities. |
| External mutation uncertainty cannot authorize blind replay. | kernel regression | eventually-consistent readback | `ReplaySafety` | disposable-agent readback | Demonstrated for current adapters and modeled abstractly. |
| Production provider mutation requires kernel-minted `EffectAuthority` and reserves immediately before the effect. | `src/authority/engine.ts`, `src/providers/effect-dispatch.ts`, provider effect regressions, compile-fail/API-surface tests | typed-capability-authority + effect-authority-decay experiments | `ReservationSafety` covers the abstract reservation boundary | disposable-agent workflow invoking the production adapter | The admitted GitHub mutation functions no longer accept raw execution permits; authority is kernel-instance-bound and current-generation fenced. Other provider mutation profiles remain outside the production slice. |
| Independent effects can overlap without globally serializing execution. | kernel regression | two-effect concurrency | — | — | Demonstrated locally. |
| Canonically conflicting effects do not race by scheduler luck. | kernel regression | conflicting-effect experiment | — | — | Demonstrated for the GitHub commit-status coordinate semantics. |
| GitHub observations come from a generated read vocabulary plus explicit handwritten semantics. | GitHub observation tests | observation grammar experiment | — | GitHub observation grammar workflow | Demonstrated for the covered Git ref slice; broad endpoint semantics remain open. |
| A worker can receive an exact declared GitHub-object workspace and return a bounded candidate without repository authority. | — | — | — | GitHub object transport workflow | Demonstrated by the hosted transport proof; closure selection is intentionally separate. |
| A stale execution generation is rejected even when project revision is unchanged. | `test/git-kernel.test.ts`; execution-permit validation in `src/storage/git-kernel.ts`; core-loop effect callback receives no permit | disposable-agent and destructive-recovery stress paths rotate authority after worker loss | `MutationAuthoritySafety` plus `BrokenNoFence.cfg` | disposable-agent workflow run `35389453056` | Demonstrated at the Git kernel permit boundary and through hosted generation 1 worker → generation 2 broker → generation 3 recovery handoff. |
| An unresolved authorized mutation blocks a conflicting successor effect across authority generations. | kernel reservation regression tests; `performEffect` privately commits reservation before invoking the provider effect and proves failed reservation prevents invocation | disposable-agent, eventual-consistency, concurrency, and Git stress experiments | `ReservationSafety` plus `BrokenNoReservation.cfg` | disposable-agent workflow run `35389453056` | Demonstrated for the admitted provider mutation surface: registered provider effects require kernel-minted `EffectAuthority`, and fresh recovery reconciles unresolved effects rather than replaying them. Arbitrary external provider clients remain outside Overcenter's authority model. |
| `DONE` is derived from exact retained evidence rather than assigned as privileged state. | pure replay and reconstruction tests | disposable-agent settlement | `NoFalseDone` plus `BrokenNoEvidence.cfg` | disposable-agent proof | Demonstrated for the current Git receipt model; compact portable attestations remain a research target. |
| One confined attempt owns one exact cgroup leaf, final resource evidence follows whole-tree death, and per-attempt limits sit below a finite aggregate pool. | `src/execution/confined-executor.ts`, `src/execution/manifest.ts`, `src/execution/confinement/resource.rs`, execution-manifest regressions | real cgroup-v2 hostile proof: PID exhaustion, CPU throttling, OOM containment, HugeTLB denial, stale-leaf noninterference, supervisor timeout/output cleanup | `ResourceContainment.tla`: `ExactLeafAuthority`, `FinalEvidenceSafety`, `RemovalSafety`; negative controls `BrokenResourceIdentity.cfg`, `BrokenResourceEarlyEvidence.cfg` | — | Demonstrated only for the supported Linux x86-64 confinement substrate; I/O/disk quota and authority-aware orphan recovery remain open. |

## Evidence discipline

The maintenance rule is simple:

1. A README statement under **What is proved?** needs a witness in this table.
2. An implementation guarantee needs implementation or executable experiment evidence. A TLA+ result alone does not upgrade runtime behavior.
3. A formal safety claim needs a checked invariant and, where practical, a negative control showing the model can express the failure.
4. A provider claim needs real-provider evidence. Mock transport is not provider proof.
5. The deterministic CI workflow must run `npm test`, `npm run proof:local`, and `npm run proof:formal`; no one-off workflow should silently become the only witness for a local/formal claim.
6. A semantic-oracle claim must name both the evaluated production revision and exact reference revision, distinguish universal proof from bounded differential agreement, and state whether the witness is current or historical. Oracle agreement does not promote the oracle into runtime authority.
7. `proof:live` must wait for every real-provider hosted proof and verify that every run executed the same exact source revision. Dispatch success is not proof success.

## Deliberately open proof obligations

The most important current gaps are not more scheduler features. They are boundaries the research already knows it needs but has not implemented generally:

- establishing effect-confinement boundaries for additional execution substrates; uncontrolled parent-agent tools or credentials remain outside the Rust child-process guarantee, while authority confinement must continue to hold without them;
- a general producer-independent realization cache keyed by complete semantic inputs;
- compact portable transition attestations with an explicit trust-root story;
- provider-specific negative-evidence and settlement semantics beyond the small GitHub slices already exercised;
- liveness assumptions strong enough to justify any eventual-progress claim.

These should remain visible as gaps until their corresponding evidence exists. Do not convert them into product claims by inference from neighboring tests.
