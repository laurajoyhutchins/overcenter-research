# Operator commands

Overcenter exposes semantic commands, not execution choreography.

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
          agent.submit
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

## `agent.submit`

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

The GitHub transport may use refs, workflow events, artifacts, and reruns internally. Those mechanics are deliberately hidden behind `project.advance` and `agent.submit`.

## Pull-request certification

`candidate.certify` is a separate repository-maintenance command. It is not part of the reasoning-agent work protocol.

For a same-repository pull request, rerunning the single `candidate.certify` job dispatches the exact-head Merge gate. The command derives repository, pull request, source SHA, branch ref, workflow-run identity, and rerun attempt from the trusted GitHub event. It accepts no free-form payload.

The Merge gate independently verifies that the dispatched run still refers to the requested exact source SHA. Successful command dispatch is transport evidence, not proof that candidate verification succeeded.

## Trusted command anchors

Each semantic command has one small workflow with one rerunnable command job.

The first run is inert and advertises command availability. Rerunning the job invokes the command. Privileged command code is always taken from trusted repository state, never from untrusted candidate bytes.

Current commands:

| Command | Meaning |
| --- | --- |
| `project.advance` | Let Overcenter make progress and return reasoning work only when needed. |
| `agent.submit` | Validate and settle a candidate produced from an assigned packet. |
| `candidate.certify` | Certify an exact pull-request head for merge. |

The internal candidate handoff workflow has no write authority. It exists only to materialize a trusted `agent.submit` command anchor and is not part of the operator surface.

## Extension rule

Add a command only when it represents a stable semantic intent.

Do not expose CRUD, arbitrary REST, arbitrary workflows, free-form JSON commands, graph selection, claim mechanics, or recovery bookkeeping. If the caller can derive or coordinate it mechanically, Overcenter should own it instead.
