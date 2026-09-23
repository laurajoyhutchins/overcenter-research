# ADR-0010: Separate controlled and uncontrolled agent harnesses

**Status:** Accepted

## Decision

Overcenter distinguishes execution integrations by whether it controls the harness boundary relevant to the work.

### Controlled harness

A harness is **controlled** when Overcenter owns and can enforce the relevant execution boundary, including the parts that matter to the integration such as process launch, workspace access, inherited descriptors and environment, resource containment, and credentials exposed to the worker.

The worker remains untrusted. The important property is that deterministic software controls the boundary around it.

For supported Linux native execution, ADR-0008 records the Rust confinement substrate used for this class.

### Uncontrolled harness

A harness is **uncontrolled** when the surrounding agent platform may independently grant capabilities that Overcenter cannot revoke, inspect completely, or place behind its own process boundary. Examples include host-provided tools, provider credentials, network access, MCP capabilities, or mutation APIs owned by the parent platform.

Running one subprocess inside an Overcenter-controlled sandbox does not convert the surrounding harness into a controlled one.

An integration may also be mixed. Classification applies to the specific boundary relevant to a capability, not to a vendor or agent product as a whole.

## Shared interface

The common abstraction belongs above physical execution:

```text
                    authorized work
                         |
          +--------------+--------------+
          |                             |
 controlled harness               uncontrolled harness
          |                             |
 owned execution boundary         host execution boundary
          |                             |
          +--------------+--------------+
                         |
               candidate realization,
                proposal, or evidence
```

A generic agent interface should therefore describe work and returned artifacts at this level. It should not require every worker to share one low-level executor or imply that Overcenter owns a physical boundary it does not control.

## Evidence

ADR-0008 demonstrates the controlled-harness case for the supported Linux path: Overcenter owns the launcher and the process/resource boundary it enforces.

PR #261, **Experiment: separate ambient authority from settlement authority**, supplies the hostile witness for the uncontrolled case. A foreign worker could receive a provider capability directly from its hosting environment even though an inner restricted process could not revoke that parent capability.

That result is sufficient for this ADR's narrower conclusion: harness ownership must be represented explicitly rather than inferred from the presence of an inner sandbox.

## Consequences

- Every execution integration must state which relevant harness boundary is controlled and which is not.
- A controlled-harness mechanism may be used only for boundaries Overcenter actually owns and can test.
- An uncontrolled harness is integrated through the higher-level work/proposal/evidence interface rather than being described as an Overcenter-owned sandbox.
- A future universal worker API belongs above the controlled/uncontrolled split, not beneath it.
- Runtime consolidation work, including Rust consolidation, applies only to execution boundaries Overcenter controls.
- Documentation and tests must avoid promoting an inner process boundary into a claim about the surrounding host platform.

## Out of scope

This ADR does **not** define:

- how worker actions become authoritative project truth;
- the distinction between authority confinement and effect confinement;
- settlement, readback, or recovery semantics;
- which external effects a worker may be delegated.

Those cross-cutting safety guarantees are documented separately by the authority-vs-effect confinement architecture work.

## Rejected alternatives

### Treat every agent as physically sandboxable

Rejected. A parent platform can own capabilities outside the jurisdiction of an inner sandbox.

### Collapse all workers to one low-level executor contract

Rejected. That would either discard useful controls available when Overcenter owns the harness or imply controls that do not exist for a foreign harness.

### Require Overcenter to own every harness

Rejected. External reasoning services and hosted agents can still participate through the higher-level work/proposal/evidence interface.

## Revisit when

Revisit this split if external agent platforms expose independently verifiable capability boundaries strong enough for Overcenter to treat specific host capabilities as controlled, or if the controlled substrate loses the enforcement properties required by ADR-0008.
