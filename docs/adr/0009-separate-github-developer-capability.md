# ADR-0009: Separate developer GitHub capability from Overcenter authority

**Status:** Accepted

## Decision

Broad GitHub development capability and Overcenter authority are separate systems.

The existing general-purpose GitHub App is designated **Laura's Dev Tools**. It may back developer-facing MCP tools, CLIs, scripts, and other automation for ordinary GitHub work such as inspecting repositories, manipulating branches and pull requests, dispatching or rerunning workflows, and downloading artifacts.

Laura's Dev Tools is not an Overcenter command surface and is not an Overcenter trust root. Its App identity, bot actor, hook ID, installation ID, installation token, or possession of GitHub permissions does not by itself authorize an Overcenter transition or make an observed GitHub fact admissible settlement evidence.

Overcenter continues to expose semantic project intent rather than GitHub choreography. The reasoning-agent protocol remains:

- `project.advance`
- `project.submit`

Developer tools may cause real GitHub state changes. Overcenter may subsequently observe those changes through its ordinary provider observation machinery, but it must establish the relevant exact identity, admissibility, authorization, and postcondition independently before project truth changes.

Overcenter does not require or use a GitHub App for routine operation. Repository-local commands use GitHub Actions' native `github.token`, and provider code accepts ordinary bearer credentials rather than an App identity. Any GitHub mutation authority required by a trusted effect is granted to the exact execution attempt through those ordinary scoped credentials.

## Evidence

The operator surface already states that arbitrary GitHub REST endpoints and workflow names are not supported Overcenter agent operations. The current semantic command workflows reduce the reasoning-agent interface to `project.advance` and `project.submit`.

The GitHub provider implementation already separates several concerns:

- certified reads bind observations to exact repository/object coordinates and a pinned provider contract;
- effect execution checks an Overcenter execution permit before performing provider mutation;
- the normal operator workflows use GitHub Actions' native `github.token` rather than an App credential;
- provider reads and trusted effects accept generic bearer credentials;
- settlement remains a project-authority decision rather than a provider-API response.

The former App-specific webhook delivery mirror was removed rather than retained as an optional path. Its additional credential, persistence, reconciliation, and trust surface was not needed for the current routine operation model. GitHub status verification now uses the same certified provider-read path as other ordinary observations.

## What remains outside this decision

This ADR does not:

- expose a generic GitHub request primitive as an Overcenter command;
- make broad developer mutations safe merely because they use Laura's Dev Tools;
- require Overcenter to use a GitHub App for routine operation;
- change the exact-revision, effect-permit, observation, recovery, or settlement rules;
- claim that a GitHub status, check, workflow result, comment, branch, or other provider fact is authoritative without its own admitted verification semantics.

The operational rename and permission configuration of the GitHub App are deployment work, not repository authority semantics.

## Placement rule

Use the following test when adding GitHub functionality:

**Developer capability:** if a competent developer would reasonably ask GitHub to perform the operation directly, it belongs in Laura's Dev Tools rather than the Overcenter agent interface.

**Project authority:** if correctness depends on graph eligibility, exact execution identity, reconciliation, mutation certainty, verification, recovery, or settlement, it belongs behind Overcenter semantics.

A developer tool can be a transport or actuator used during development. It cannot bypass the Overcenter authority boundary.

## Rejected alternatives

### Add missing GitHub APIs as first-class Overcenter tools

Rejected. That would turn Overcenter into a GitHub API wrapper and leak execution choreography into the semantic project interface.

### Keep the existing broad App as an Overcenter identity and create a second broad developer App

Rejected. The existing App is better suited to general developer automation. Overcenter should retain only the narrow provider authority it actually needs.

### Let one broad App identity imply both developer capability and Overcenter authority

Rejected. A credential able to freely create an observed provider fact must not make that fact trusted settlement evidence merely by being the credential that created it.

## Consequences

- The developer-facing GitHub MCP should live outside the Overcenter command surface, preferably in its own repository.
- Laura's Dev Tools may have broader GitHub permissions than Overcenter, because its permissions do not confer Overcenter semantic authority.
- Routine Overcenter operation must remain GitHub-App-independent. Native Actions credentials or another ordinary scoped bearer token are sufficient for the standard path.
- There is no App-specific webhook delivery or status-mirror runtime path in the supported implementation.
- Overcenter-specific GitHub mutation credentials should be introduced only for explicit trusted effects and kept least-privilege.
- Provider observations must continue to bind exact provider identity and evidence independently of which developer tool may have caused the observed state.
- Existing provider code may share low-level GitHub schemas or mechanics with developer tooling, but the developer tool surface must not become an Overcenter public API by import accident.
- Reintroducing GitHub App-specific runtime machinery requires new evidence that it provides a property the ordinary scoped-token path cannot provide more simply.

## Revisit when

Revisit this decision only if a concrete requirement demonstrates that ordinary scoped GitHub credentials cannot provide a needed property and a GitHub App path can provide it without becoming a routine-operation dependency.
