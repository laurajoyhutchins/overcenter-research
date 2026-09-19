# Proof obligations

Overcenter's evidence surface should answer a stricter question than "are the tests green?":

> Which claim is being exercised, at which layer, and what does a green result actually establish?

The evidence classes remain deliberately separate. The first three are continuously enforced by `.github/workflows/tests.yml` on pull requests and `main`; the semantic-oracle lane is source-scoped to the production semantics it checks; the live provider lane remains separately dispatchable:

- `npm test` — deterministic implementation invariants;
- `npm run proof:local` — adversarial executable experiments;
- `npm run proof:formal` — model-checked safety properties and negative controls;
- Lean semantic-oracle CI — bounded exhaustive differential against an exact pinned Lean reference;
- `npm run proof:live` — real GitHub provider proofs at one exact source revision.

A claim is not promoted merely because an adjacent evidence class is green.

## Current obligation map

| Obligation | Implementation | Local adversarial | Formal | Live provider | Current boundary |
| --- | --- | --- | --- | --- | --- |
| Projection is reconstructed from durable facts rather than a privileged lifecycle snapshot. | `test/projection-pure.test.ts`, `test/projection-reconstruction.test.ts` | disposable-agent reconstruction | — | disposable-agent proof | Demonstrated for the Git prototype. |
| A claim is bound to the exact authority revision and semantic obligation identity. | `test/git-kernel.test.ts`, `test/dependency-edge-adversarial.test.ts` | CAS contention | `ExactRevisionEvidence` | disposable-agent proof | Demonstrated for Git authority; lease-generation fencing is separate. |
| Realization state is distinct from execution eligibility. | `test/lifecycle-pure.test.ts`, `test/graph-pure.test.ts` | conflict projection | — | — | Demonstrated for the current graph/projection mechanism. |
| Production graph validity and normalized effect ordering remain aligned with the Lean semantic reference. | `src/graph/topology.ts`, `src/authority/admission.ts`, `src/semantics.ts` | `test/lean-semantic-oracle.test.ts`: all 8,192 directed four-node graph/dependency-kind comparisons plus 8 hostile/mixed graph cases, and 245,768 effect-order comparisons across control/semantic edges, conflicting/commuting/distinct-resource cases, mixed-kind paths, and multi-effect scan adversaries | graph acyclicity soundness is proved in pinned Lean oracle revision `0c5db60f2dc14af93f554fd9f870181261ce5f11`; effect ordering currently has bounded differential evidence, not universal equivalence | — | The source-scoped Lean semantic-oracle workflow checks this relation against exact pinned oracle revision `0c5db60f2dc14af93f554fd9f870181261ce5f11`. Provider-specific effect normalization remains TypeScript semantics. |
| Semantic dependencies invalidate or reuse downstream work according to selected upstream identity. | `test/dependency-edge-adversarial.test.ts` | — | — | — | Demonstrated for the implemented selectors, not a general realization cache. |
| Worker-local destruction cannot manufacture or erase project truth. | kernel regression | disposable-agent experiment | — | disposable-agent workflow run `35389453056` at exact revision `f8a883d6214d76b0b609eb05e3798d6238d108cc` | Demonstrated for project-authority separation and GitHub Actions provider-write separation: worker write attempts were denied, trusted broker performed the reserved effect, and fresh recovery settled from readback. |
| External mutation uncertainty cannot authorize blind replay. | kernel regression | eventually-consistent readback | `ReplaySafety` | disposable-agent readback | Demonstrated for current adapters and modeled abstractly. |
| Independent effects can overlap without globally serializing execution. | kernel regression | two-effect concurrency | — | — | Demonstrated locally. |
| Canonically conflicting effects do not race by scheduler luck. | kernel regression | conflicting-effect experiment | — | — | Demonstrated for the GitHub commit-status coordinate semantics. |
| GitHub observations come from a generated read vocabulary plus explicit handwritten semantics. | GitHub observation tests | observation grammar experiment | — | GitHub observation grammar workflow | Demonstrated for the covered Git ref slice; broad endpoint semantics remain open. |
| A worker can receive an exact declared GitHub-object workspace and return a bounded candidate without repository authority. | — | — | — | GitHub object transport workflow | Demonstrated by the hosted transport proof; closure selection is intentionally separate. |
| A stale execution generation is rejected even when project revision is unchanged. | `test/git-kernel.test.ts`; execution-permit validation in `src/storage/git-kernel.ts`; core-loop effect callback receives no permit | disposable-agent and destructive-recovery stress paths rotate authority after worker loss | `MutationAuthoritySafety` plus `BrokenNoFence.cfg` | disposable-agent workflow run `35389453056` | Demonstrated at the Git kernel permit boundary and through hosted generation 1 worker → generation 2 broker → generation 3 recovery handoff. |
| An unresolved authorized mutation blocks a conflicting successor effect across authority generations. | kernel reservation regression tests; `runCoreLoop` commits reservation before invoking the effect handler and proves failed reservation prevents invocation | disposable-agent, eventual-consistency, concurrency, and Git stress experiments | `ReservationSafety` plus `BrokenNoReservation.cfg` | disposable-agent workflow run `35389453056` | Demonstrated for the normal core-loop mutation path using the Git reference backend; the hosted broker reserved before provider mutation and fresh recovery reconciled the unresolved effect rather than replaying it. Arbitrary low-level provider calls remain outside the guarantee. |
| `DONE` is derived from exact retained evidence rather than assigned as privileged state. | pure replay and reconstruction tests | disposable-agent settlement | `NoFalseDone` plus `BrokenNoEvidence.cfg` | disposable-agent proof | Demonstrated for the current Git receipt model; compact portable attestations remain a research target. |

## Evidence discipline

The maintenance rule is simple:

1. A README statement under **What is proved?** needs a witness in this table.
2. An implementation guarantee needs implementation or executable experiment evidence. A TLA+ result alone does not upgrade runtime behavior.
3. A formal safety claim needs a checked invariant and, where practical, a negative control showing the model can express the failure.
4. A provider claim needs real-provider evidence. Mock transport is not provider proof.
5. The deterministic CI workflow must run `npm test`, `npm run proof:local`, and `npm run proof:formal`; no one-off workflow should silently become the only witness for a local/formal claim.
6. A semantic-oracle claim must name the exact reference revision and distinguish universal proof from bounded differential agreement. Oracle agreement does not promote the oracle into runtime authority.
7. `proof:live` must wait for every real-provider hosted proof and verify that every run executed the same exact source revision. Dispatch success is not proof success.

## Deliberately open proof obligations

The most important current gaps are not more scheduler features. They are boundaries the research already knows it needs but has not implemented generally:

- extending physical worker/provider credential separation beyond the GitHub Actions proof and reducing low-level mutation paths outside the reserved core-loop boundary;
- a general producer-independent realization cache keyed by complete semantic inputs;
- compact portable transition attestations with an explicit trust-root story;
- provider-specific negative-evidence and settlement semantics beyond the small GitHub slices already exercised;
- liveness assumptions strong enough to justify any eventual-progress claim.

These should remain visible as gaps until their corresponding evidence exists. Do not convert them into product claims by inference from neighboring tests.
