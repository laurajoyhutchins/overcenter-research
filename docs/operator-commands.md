# Operator commands

Overcenter exposes semantic intent, not execution choreography.

For a reasoning agent, the interface is:

```text
project.advance
      |
      +--> project state
      |
      +--> work packet
              |
           reasoning
              |
              v
          project.submit
              |
              v
        verified receipt
```

That is the whole agent-facing protocol.

## `project.advance`

Ask Overcenter to make progress.

The caller supplies no obligation ID, selector, priority, lease, run ID, or execution plan. Overcenter owns those mechanics. It reconciles authoritative state, derives the executable frontier, chooses work, and claims the exact revision.

The result is either current project state or an immutable work packet when reasoning is required.

A reasoning agent does not select or claim its own work.

## `project.submit`

Return the candidate produced from a work packet.

Overcenter binds the candidate to the original assignment, reconstructs authoritative run identity, acquires fresh execution authority, observes the required postcondition independently, and settles only if verification succeeds.

A reasoning agent does not declare success or settle its own run.

## What is not an interface

The following are implementation details and are not supported agent operations:

- creating request records;
- selecting obligations;
- acquiring leases;
- manipulating execution generations;
- publishing response records;
- constructing authority coordinates;
- manually settling receipts;
- invoking arbitrary GitHub REST endpoints or workflow names.

The GitHub transport may use refs, workflow events, artifacts, and reruns internally. Those mechanics are deliberately hidden behind `project.advance` and `project.submit`.

## Developer GitHub capability

Broad GitHub development operations belong to **Laura's Dev Tools**, not to the Overcenter command surface.

That includes ordinary developer mechanics such as inspecting GitHub objects, creating branches, manipulating pull requests, dispatching or rerunning workflows, and retrieving artifacts. These operations may be useful to a reasoning agent acting as a developer, but they do not become Overcenter project transitions merely because an agent invokes them.

A Laura's Dev Tools mutation creates provider state. Overcenter may later observe that state, but it must independently establish the exact identity, admissibility, authorization, and postcondition required for settlement.

The Dev Tools App identity, installation, bot actor, webhook hook, or token is provider capability/provenance rather than Overcenter semantic authority. Overcenter does not use that App for routine runtime observation: repository-local `project.advance` and `project.submit` run with GitHub Actions' native `github.token`, and provider operations use ordinary scoped bearer credentials. The former App-backed webhook status mirror has been removed. See [ADR-0009](./adr/0009-separate-github-developer-capability.md).

## Pull-request certification

Pull-request certification is CI behavior, not a separate Overcenter command.

A new PR head gets a cheap Merge gate attempt with the `Certify candidate` evidence job. Rerunning that existing job is the explicit request to spend the full exact-head evidence suite. The rerun keeps the original PR event identity, and the evidence workflow checks out and verifies that exact source SHA before running candidate-only proofs.

```text
PR head
  |
  +--> attempt 1: cheap preflight
  |
  +--> rerun Certify candidate
             |
             v
       full exact-head evidence
             |
             v
          Merge gate
```

There is no dispatch adapter, command receipt, or second workflow run whose only purpose is to ask for certification.

## Trusted command anchors

The remaining semantic command workflows are:

| Command | Meaning |
| --- | --- |
| `project.advance` | Let Overcenter make progress and return reasoning work only when needed. |
| `project.submit` | Validate and settle a candidate produced from an assigned packet. |

The internal candidate handoff workflow has no write authority. It exists only to materialize a trusted `project.submit` command anchor and is not part of the operator surface.

## Extension rule

Add a command only when it represents stable semantic intent that cannot already be expressed by an existing authoritative transition.

Do not expose CRUD, arbitrary REST, arbitrary workflows, free-form JSON commands, graph selection, claim mechanics, recovery bookkeeping, or transport wrappers. If the caller can derive or coordinate it mechanically, Overcenter should own it instead.

If a capability is useful for ordinary GitHub development but does not express an Overcenter project transition, put it in Laura's Dev Tools rather than widening this interface.
