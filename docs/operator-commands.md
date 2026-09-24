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

If the exact trusted command source contains `.overcenter/project-intent.json`, `project.advance` first compiles that declarative intent into exact-source-bound agent obligations and feeds the resulting ensure-set through the kernel's ordinary graph reconciliation boundary. The intent never carries an authority revision or source SHA; those are derived by trusted software. Omitted obligations are not retired, so partial intent cannot delete unrelated project work.

The file is producer input to `project.advance`, not another agent-facing command. A future deterministic or reasoning-backed graph producer can emit the same narrow contract without gaining graph-patch, claim, or settlement authority.

The result is either current project state or an immutable work packet when reasoning is required. Pure-candidate packets contain `assignment.json`, the command receipt, and a capability-free native `overcenter` worker executable. The executable validates and materializes the assignment, runs the declared task, and emits candidate bytes bound to the exact assignment/run/revision.

Source-change packets instead carry a bounded source assignment: semantic objective, exact claim binding, and the only repository paths the worker may replace or delete. Reasoning returns a `SourceProposal` describing those file bytes. It does not receive Git publication authority. Trusted broker software re-establishes the live run and exact source claim, rejects stale or out-of-scope proposals, forbids the `.overcenter/**` and `.github/**` control planes, materializes a one-parent candidate commit, and only then publishes the internal candidate ref.

The worker executable and source proposal protocol carry no project-settlement or provider authority. The current published binary target for pure-candidate work is statically linked Linux x86-64; portability across trust domains is independent of adding further OS/architecture builds. Either packet kind can be handed to an Overcenter-controlled sandbox or a foreign sandbox whose ambient capabilities Overcenter cannot revoke; in the latter case Overcenter still protects project truth, but cannot prevent effects independently authorized by that host.

A reasoning agent does not select or claim its own work.

## `project.submit`

Return the candidate produced from a work packet.

For pure-candidate work, Overcenter binds the returned candidate bytes to the original assignment and independently observes the required postcondition. For source-change work, trusted software first brokers the bounded proposal into an internal candidate commit; candidate code is then verified with read-only repository authority, and the write-capable submit path only reconstructs that verified tree and attempts an exact-base Git CAS.

In both cases Overcenter reconstructs authoritative run identity, acquires fresh execution authority, and settles only from trusted verification evidence. A moved source base returns source work to `READY`; an ambiguous mutation outcome remains `RECOVERY_REQUIRED` rather than being replayed blindly.

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

The internal candidate handoff workflow has no write authority. For source work it reuses the repository's exact-candidate evidence suite and records the result as verifier evidence; it never publishes or integrates source. It exists only to materialize a trusted `project.submit` command anchor and is not part of the operator surface.

## Extension rule

Add a command only when it represents stable semantic intent that cannot already be expressed by an existing authoritative transition.

Do not expose CRUD, arbitrary REST, arbitrary workflows, free-form JSON commands, graph selection, claim mechanics, recovery bookkeeping, or transport wrappers. If the caller can derive or coordinate it mechanically, Overcenter should own it instead.
