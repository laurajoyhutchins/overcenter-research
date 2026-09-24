# ADR-0009: Separate GitHub developer capability from Overcenter authority

**Status:** Accepted

## Decision

Broad GitHub developer automation is not part of Overcenter's routine command or authority surface. Overcenter keeps only the provider capabilities required by admitted observations and narrowly authorized effects. General repository administration and developer convenience belong in separate tooling.

A GitHub credential is a capability to affect GitHub. It is not, by itself, authority to redefine Overcenter project truth.

## Context

The research repeatedly separates two questions:

1. can an actor change external provider state?
2. can that actor cause Overcenter to accept a project claim as true?

The ambient-authority and disposable-worker evidence show these are different boundaries. An over-capable worker may be able to create provider state while remaining unable to settle project truth. Conversely, the trusted effect broker needs a provider write credential for one admitted effect without becoming a general-purpose GitHub automation service.

Keeping a GitHub App or broad developer API inside the normal Overcenter interface would blur that distinction and encourage workflows to route ordinary repository operations through project authority.

## Consequences

- `project.advance` and `project.submit` remain the supported semantic operator commands.
- Provider-specific production effects must derive exact coordinates from authoritative obligations and cross the kernel's authorization/reservation boundary.
- Broad GitHub CRUD, arbitrary REST calls, issue/PR convenience operations, and general developer automation stay outside the Overcenter command surface.
- A separately held developer credential may propose or create external state, but Overcenter independently establishes identity, admissibility, observation, verification, and settlement before that state can become project truth.
- Provider permissions should still be narrowed where the provider supports it; separation of project authority is not an excuse for unnecessary ambient credentials.

## Rejected alternatives

### Make a GitHub App the routine Overcenter control plane

Rejected because it couples project authority to a broad provider integration and makes provider CRUD appear authoritative merely because it is convenient.

### Expose arbitrary GitHub operations as Overcenter commands

Rejected because callers would coordinate low-level execution choreography that deterministic software should own, and because most such operations have no project-truth semantics.

## Revisit when

Revisit if Overcenter develops a provider-neutral capability system that can express broad developer operations without conflating them with project authority, or if a concrete production requirement demonstrates that a currently external GitHub operation is itself stable semantic project intent and can satisfy the normal effect/observation/recovery requirements.
