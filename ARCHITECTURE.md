
Evidence for revision A cannot settle revision B merely because the data looks similar.

## 11. Settlement

**Settlement** is the authoritative project-state commit boundary.

A safe settlement conceptually rechecks:

```text
current execution authority
AND
exact project revision
AND
acceptable mutation certainty
AND
exact verification evidence
AND
no conflicting terminal settlement
```

then performs a compare-and-swap against project authority.

Settlement is deliberately later than execution.

```text
execution success
    !=
settlement

verification success
    !=
settlement

candidate integration
    !=
settlement

settlement
    =
authoritative acceptance of exact evidence
```

A lost acknowledgement after successful settlement should be resolved idempotently from durable state rather than creating a second semantic terminal result.

## 12. Durable evidence

The evidence model follows the principle:

> Preserve proofs, not exhaust.

Correctness-critical durable evidence should be enough to justify terminal project truth after ordinary execution machinery disappears.

That can include:

- obligation identity;
- exact input/source/graph revision;
- authorization/fencing identity;
- material effect identity;
- authoritative observations;
- verification result and verifier version;
- settlement identity;
- resulting project-state digest;
- amendment ancestry where relevant.

Ordinary scheduler wakes, retries, heartbeats, duplicate responses, and temporary logs are usually execution telemetry rather than permanent project truth.

The transition-attestation research proposes an eventual compact envelope for this information.

## 13. Project state is a projection

Statuses such as `READY` and `DONE` are useful operator surfaces.

They should not be confused with the deepest historical truth.

The implementation distinguishes **realization state** from these operator states. An obligation with no currently valid realization or active run is internally `UNREALIZED`. Only deterministic eligibility may project `UNREALIZED` to public `READY` or `BLOCKED`. This prevents "not yet realized" from being confused with "safe to execute now."

Before an obligation can enter authoritative history, graph admission now rejects facts that are already mechanically known to be unsafe or meaningless:

- unsupported semantic selectors;
- semantic outputs the upstream verifier cannot identify;
- unknown dependencies and cycles;
- statically known unordered incompatible effect coordinates.

Definition or amendment failure therefore happens before the authority CAS. These defects are not represented as runtime `BLOCKED` work.

Settlement authority is also verifier-specific before execution begins. A generic observation field such as `mutation_certainty: "absent"` does not itself authorize replay. The obligation's verifier semantics must declare that its negative evidence can be authoritative.

### READY

An obligation is READY when:

- its structural prerequisites are satisfied;
- no dynamic eligibility condition blocks it;
- no valid existing realization already satisfies it;
- no unresolved prior mutation forbids replay;
- current authority permits a new attempt.

### EXECUTING

A currently authorized run exists and has not yet reached a durable non-executing disposition.

### WAITING

The work is intentionally suspended on a known external condition, human decision, timer, or dependency that does not imply mutation uncertainty.

### BLOCKED

Deterministic structure or policy says execution cannot safely proceed.

Examples:

- unsatisfied dependencies;
- a dynamic execution precondition is not currently met.

Invalid graph/amendment structure and statically knowable effect conflicts are earlier admission failures, not runtime `BLOCKED` states.

### RECOVERY_REQUIRED

A prior attempt cannot safely be treated as success or absence.

Typical causes:

- provider outcome may have mutated;
- provider readback is incomplete or conflicting;
- an exact authoritative observation is unavailable;
- recovery must reconcile an interrupted run.

### DONE

DONE should be understood semantically as:

```text
valid terminal settlement exists
AND
required effect / realization is established
AND
verification binds exact obligation/revision
AND
durable evidence remains sufficient
```

A product may cache a DONE label.

The architectural truth is the predicate over evidence.

## 14. Graph semantics

The current graph is intentionally simpler than a general workflow language.

Its base semantics are:

- finite directed acyclic dependency graph;
- `requires` is AND semantics;
- roots can be enabled independently;
- fan-out is AND-split;
- fan-in is AND-join;
- concurrency comes from absence of causal dependency;
- completed facts grow monotonically.

Do not infer XOR or OR semantics from topology.

If alternative-path semantics are ever added, they should be explicit constructs with explicit correctness rules.

## 15. Effect ordering and concurrency

Project-authority updates may serialize through one CAS coordinate without forcing external effects themselves to execute serially.

The prototype demonstrates:

- independent obligations can remain `EXECUTING` simultaneously;
- independent recovery processes can settle through one authority ref;
- exact claim identity survives later authority movement.

For the canonical GitHub commit-status adapter, effect semantics currently identify a resource by:

```text
repository identity
+ exact commit
+ normalized status context
```

Two effects on that coordinate:

- may commute when their desired state is explicitly identical;
- must be ordered when desired states conflict;
- otherwise become `BLOCKED` rather than racing.

This is adapter-specific.

A verifier that cannot define a canonical mutation coordinate must not pretend to provide generic conflict semantics.

## 16. Amendments are workflow-state migration

Changing the graph after work has completed is not merely editing configuration.

An amendment must preserve causal validity of already-established project truth.

A useful minimum rule from the Petri-net/workflow analysis is:

> The completed set must remain predecessor-closed under the amended graph.

An amendment must not retroactively declare that a completed transition depended on something that was not complete when that transition became valid, unless a deliberate migration/revalidation protocol supplies new evidence.