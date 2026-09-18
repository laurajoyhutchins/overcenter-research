# Proof obligations

Overcenter's evidence surface should answer a stricter question than "are the tests green?":

> Which claim is being exercised, at which layer, and what does a green result actually establish?

The evidence classes remain deliberately separate. The first three are continuously enforced by `.github/workflows/tests.yml` on pull requests and `main`; the live provider lane remains separately dispatchable:

- `npm test` — deterministic implementation invariants;
- `npm run proof:local` — adversarial executable experiments;
- `npm run proof:formal` — model-checked safety properties and negative controls;
- `npm run proof:live` — real GitHub provider proofs at one exact source revision.

A claim is not promoted merely because an adjacent evidence class is green.

## Current obligation map

| Obligation | Implementation | Local adversarial | Formal | Live provider | Current boundary |
| --- | --- | --- | --- | --- | --- |
| Projection is reconstructed from durable facts rather than a privileged lifecycle snapshot. | `test/projection-pure.test.ts`, `test/projection-reconstruction.test.ts` | disposable-agent reconstruction | — | disposable-agent proof | Demonstrated for the Git prototype. |
| A claim is bound to the exact authority revision and semantic obligation identity. | `test/git-kernel.test.ts`, `test/dependency-edge-adversarial.test.ts` | CAS contention | `ExactRevisionEvidence` | disposable-agent proof | Demonstrated for Git authority; lease-generation fencing is separate. |
| Realization state is distinct from execution eligibility. | `test/lifecycle-pure.test.ts`, `test/graph-pure.test.ts` | conflict projection | — | — | Demonstrated for the current graph/projection mechanism. |
| Semantic dependencies invalidate or reuse downstream work according to selected upstream identity. | `test/dependency-edge-adversarial.test.ts` | — | — | — | Demonstrated for the implemented selectors, not a general realization cache. |
| Worker-local destruction cannot manufacture or erase project truth. | kernel regression | disposable-agent experiment | — | prior disposable-agent proof | Demonstrated for project-authority separation. The revised workflow additionally removes provider-write authority from the worker; that stronger claim awaits a fresh hosted run. |
| External mutation uncertainty cannot authorize blind replay. | kernel regression | eventually-consistent readback | `ReplaySafety` | disposable-agent readback | Demonstrated for current adapters and modeled abstractly. |
| Independent effects can overlap without globally serializing execution. | kernel regression | two-effect concurrency | — | — | Demonstrated locally. |
| Canonically conflicting effects do not race by scheduler luck. | kernel regression | conflicting-effect experiment | — | — | Demonstrated for the GitHub commit-status coordinate semantics. |
| GitHub observations come from a generated read vocabulary plus explicit handwritten semantics. | GitHub observation tests | observation grammar experiment | — | GitHub observation grammar workflow | Demonstrated for the covered Git ref slice; broad endpoint semantics remain open. |
| A worker can receive an exact declared GitHub-object workspace and return a bounded candidate without repository authority. | — | — | — | GitHub object transport workflow | Demonstrated by the hosted transport proof; closure selection is intentionally separate. |
| A stale execution generation is rejected even when project revision is unchanged. | `test/git-kernel.test.ts`; execution-permit validation in `src/git-kernel.ts`; core-loop effect callback receives no permit | disposable-agent and destructive-recovery stress paths rotate authority after worker loss | `MutationAuthoritySafety` plus `BrokenNoFence.cfg` | revised disposable-agent workflow pending fresh run | Demonstrated at the Git kernel permit boundary. The worker-facing core-loop callback no longer receives the permit; physical credential separation is provider/substrate-specific. |
| An unresolved authorized mutation blocks a conflicting successor effect across authority generations. | kernel reservation regression tests; `runGitCoreLoop` commits reservation before invoking the effect handler and proves failed reservation prevents invocation | disposable-agent, eventual-consistency, concurrency, and Git stress experiments | `ReservationSafety` plus `BrokenNoReservation.cfg` | revised disposable-agent workflow pending fresh run | Demonstrated for the normal Git core-loop mutation path and direct callers that use the reservation boundary; arbitrary low-level provider calls remain outside the guarantee. |
| `DONE` is derived from exact retained evidence rather than assigned as privileged state. | pure replay and reconstruction tests | disposable-agent settlement | `NoFalseDone` plus `BrokenNoEvidence.cfg` | disposable-agent proof | Demonstrated for the current Git receipt model; compact portable attestations remain a research target. |

## Evidence discipline

The maintenance rule is simple:

1. A README statement under **What is proved?** needs a witness in this table.
2. An implementation guarantee needs implementation or executable experiment evidence. A TLA+ result alone does not upgrade runtime behavior.
3. A formal safety claim needs a checked invariant and, where practical, a negative control showing the model can express the failure.
4. A provider claim needs real-provider evidence. Mock transport is not provider proof.
5. The deterministic CI workflow must run `npm test`, `npm run proof:local`, and `npm run proof:formal`; no one-off workflow should silently become the only witness for a local/formal claim.
6. `proof:live` must wait for every real-provider hosted proof and verify that every run executed the same exact source revision. Dispatch success is not proof success.

## Deliberately open proof obligations

The most important current gaps are not more scheduler features. They are boundaries the research already knows it needs but has not implemented generally:

- extending physical worker/provider credential separation beyond the GitHub Actions proof and reducing low-level mutation paths outside the reserved core-loop boundary;
- a general producer-independent realization cache keyed by complete semantic inputs;
- compact portable transition attestations with an explicit trust-root story;
- provider-specific negative-evidence and settlement semantics beyond the small GitHub slices already exercised;
- liveness assumptions strong enough to justify any eventual-progress claim.

These should remain visible as gaps until their corresponding evidence exists. Do not convert them into product claims by inference from neighboring tests.
