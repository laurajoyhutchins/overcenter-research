# Operator commands

Overcenter operator commands are a narrow semantic control surface for environments that can rerun GitHub Actions jobs but cannot expose a custom Overcenter tool.

The interface is intentionally not a generic command bus.

```text
reasoning session
      |
      | rerun one named job
      v
trusted command anchor
      |
      | one typed semantic operation
      v
trusted implementation workflow
      |
      | authority + provider machinery
      v
attributable result
```

The caller chooses **what Overcenter should do**. It does not assemble GitHub REST requests, execution permits, authority coordinates, or arbitrary JSON instructions.

## Current semantic commands

The current finite command set is:

- `candidate.certify` — run exact-head candidate evidence for one pull request.
- `project.advance` — advance the project deterministically until there is no work, a blocker/recovery boundary is reached, or agent judgment is required.
- `work.execute` — authorize the currently WAITING work item to execute its already-declared supported effect.

Each command has its own workflow and one rerunnable command job. Rerun permission is governed by GitHub. The first run is inert and advertises command availability; a rerun invokes the command.

The current command receipt schema is `overcenter-github-operator-command/v1`. Schema versions live in metadata; semantic command names remain stable.

## candidate.certify

For every same-repository pull-request head, `.github/workflows/operator-candidate-certify.yml` exposes:

```text
workflow: Overcenter command · candidate.certify
job:      candidate.certify
```

The command derives repository identity, pull request number, exact head SHA, branch ref, workflow run ID, and rerun attempt from the original GitHub event. Privileged command code comes from the exact trusted base SHA, never from pull-request source.

On invocation, the adapter dispatches `merge-gate.yml` and passes the captured head SHA as `source_sha`. The merge gate independently requires the selected ref to still resolve to that SHA. A moved branch therefore fails closed rather than certifying newer code.

The command accepts no free-form payload.

## project.advance

Every push to `main` materializes an inert `project.advance` command anchor. On rerun, the adapter dispatches `project-advance.yml` for the default branch and carries the exact source SHA captured by the anchor.

The implementation workflow requires its actual `GITHUB_SHA` to equal that source SHA **before authority mutation**. A stale anchor therefore cannot silently execute newer command code.

The advancement boundary is deterministic-first:

```text
derive READY
    |
 exact claim
    |
    +-- known deterministic path ----------> execute + observe + settle
    |
    +-- judgment/authorization required ---> WAITING
                                               |
                                               v
                                  capability-free agent packet
```

A WAITING packet contains the authoritative `Work` snapshot and run identity. It does not contain the ephemeral `ExecutionPermit`.

If the agent or another actor performs an external one-off procedure, the next `project.advance` attempts a **positive-only reconciliation**. `reconcileIfVerified` commits settlement only when authoritative observation already verifies the postcondition. A merely unsatisfied or uncertain read therefore leaves the run WAITING rather than manufacturing `READY` or `RECOVERY_REQUIRED`.

## work.execute

`work.execute` is not a generic executor. It is a semantic authorization for one very narrow condition:

1. authority contains exactly one current WAITING work item;
2. that immutable packet declared `execution_policy: agent-authorization/v1`;
3. the packet declared an effect contract that trusted software supports.

The command accepts no work ID, repository ID, SHA, provider coordinate, desired value, authority ref, effect contract, or free-form payload from the caller.

The implementation reacquires a fresh hidden execution generation, derives provider coordinates from the authoritative postcondition, reserves the effect durably, executes through the existing provider adapter, independently observes provider reality, and settles the same run.

For the first admitted path, the effect is the existing GitHub commit-status mutation contract in `src/providers/github-status-effect.ts`.

If execution fails after a durable effect reservation, the run becomes `RECOVERY_REQUIRED`; it is never blindly replayed. If deterministic execution fails before reservation, the work remains WAITING and the failure is returned without pretending that a provider mutation may have happened.

## Hosted closed-loop witness

The hosted experiment is documented in `experiments/closed-loop-actions/README.md`.

It uses the fixed isolated Git ref:

```text
refs/overcenter/closed-loop
```

That ref is a **research/reference authority for the hosted experiment only**. The repository's production reference path remains SQLite. The witness does not reclassify Git as the production authority backend.

The seed obligation requires an exact GitHub commit status to become `success` but requires agent authorization before the status effect may run. The intended live sequence is:

```text
project.advance
  -> AGENT_EXECUTION_REQUIRED
work.execute
  -> DONE
project.advance
  -> IDLE
```

The reasoning agent's only privileged choice is whether to invoke the advertised semantic action. Overcenter owns the effect coordinates, execution capability, reservation, observation, verification, and settlement.

## Authority and permissions

Command anchors default to no permissions. Their rerunnable jobs receive only:

```yaml
actions: write
contents: read
```

That is sufficient to dispatch their fixed trusted implementation workflows but not to mutate repository content or commit statuses.

The implementation workflows hold the stronger permissions they actually require. For the hosted `project.advance` / `work.execute` witness that is:

```yaml
contents: write
statuses: write
```

`contents: write` is used by the Git reference DurableFactStore to compare-and-swap the isolated authority ref. `statuses: write` is used only by the admitted commit-status provider adapter. Those credentials are not exposed to the reasoning session.

The command surface does not use issue comments, pull-request comments, reviews, labels, arbitrary branch commits, or free-form messages as command transport.

## Extension rule

Add a new command only when it can be expressed as a narrow semantic operation with deterministic coordinates and an attributable result.

Each new command should have:

- one stable semantic command name;
- one dedicated workflow containing exactly one rerunnable command job;
- an inert first attempt;
- a deterministic implementation from trusted code;
- minimum provider permission;
- an exact subject/revision fence;
- a typed receipt or result identity;
- tests proving stale, unsupported, ambiguous, and unauthorized requests fail closed.

Do not add an `exec`, arbitrary REST route, arbitrary workflow-name selector, or free-form JSON command. If callers repeatedly supply mechanically derivable bookkeeping, that is evidence the bookkeeping belongs in software instead.
