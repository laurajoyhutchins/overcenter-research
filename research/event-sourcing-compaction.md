# Event sourcing, CQRS, compaction, snapshots, and materialized views

## Research question

What can Overcenter learn from event sourcing, CQRS, log compaction, snapshots, and materialized views without becoming a classic event-sourced system?

The practical question is narrower: **what minimum durable history must Overcenter retain to reconstruct current project truth, recover interrupted work, reject unsafe duplicates, and justify settled transitions?** Everything else should be eligible to become disposable telemetry.

## Conclusion

Overcenter should **not** make an append-only event log the source of truth.

The smaller and more native model is:

```text
        GitHub graph @ exact SHA
                |
                v
      authoritative current truth
                +
   compact current execution state
                +
      unresolved mutation state
                +
    immutable proof / receipt spine
                +
       idempotency tombstones
                |
                v
       safe recovery + audit

  journals / heartbeats / old horizons /
  attempt traces / read projections
                |
                v
      compact, rebuild, TTL, delete
```

Overcenter's durable artifact should not be the agent's journey through execution. It should be the smallest body of evidence needed to prove that uncertain activity became a valid state transition.

A useful description is:

> **current-state transactions with an append-only proof ledger**

This fits Overcenter better than classic event sourcing because GitHub already provides immutable historical objects and exact revisions for repository-owned project truth. Overcenter does not need to duplicate Git history as a second authoritative event stream.

## Prior art

### Event sourcing

Classic event sourcing makes the event stream authoritative. Current state is reconstructed by replaying events, and snapshots are an optimization that shortens replay but do not replace the underlying history.

That model is powerful when the historical sequence itself is the domain authority. It also carries real cost: event schema evolution, replay compatibility, ordering/concurrency rules, query projections, versioning, and operational management of ever-growing histories.

Microsoft's Event Sourcing pattern documentation explicitly treats this as a specialized architecture rather than a default choice and notes the additional complexity involved:

- <https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing>

Overcenter has a simpler authority available. The repository graph at an exact Git commit already determines canonical project facts. Replaying Overcenter's command history to rediscover those facts would create a weaker duplicate authority.

### CQRS

CQRS is useful here without event sourcing.

Its relevant lesson is separation of responsibilities:

- semantic command paths own mutation validation, fencing, settlement, and durable effects;
- inspection/query paths can expose independently shaped projections optimized for decisions and operator visibility.

CQRS does not require an event store. Read and write models can share underlying authoritative storage while remaining logically separate:

- <https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs>

For Overcenter, `project.advance` and other semantic commands belong on the command side. `project.inspect`, dashboards, previews, status summaries, and search-oriented representations belong on the query/projection side.

### Materialized views

Materialized-view architecture provides a strong deletion test: a true materialized view is disposable because it can be rebuilt from its authoritative sources.

- <https://learn.microsoft.com/en-us/azure/architecture/patterns/materialized-view>

This suggests a naming and correctness discipline for Overcenter:

> If a table or structure is described as a projection, cache, snapshot, status, observation, horizon, rollup, preview, or journal, destroying it must not change what Overcenter may safely authorize.

If deletion changes settlement safety, recovery, idempotency, or truth, the structure is not merely a projection. The required fact belongs in the correctness kernel.

### Kafka log compaction

Kafka's compaction model preserves the latest value for a key rather than retaining every update forever, while tombstones preserve deletion semantics long enough for consumers to converge.

- <https://kafka.apache.org/documentation/#compaction>

The useful idea for Overcenter is informational rather than technological: **retain the latest authoritative state for each identity plus the minimum tombstones required to prevent unsafe resurrection or duplicate effects.**

Overcenter can implement that property relationally without adopting Kafka or a replay log.

### Temporal workflow history

Temporal illustrates the cost of replay-based durable execution. Workflow Event History is correctness-critical because workflow state is reconstructed through deterministic replay. Long histories therefore have operational consequences, and Continue-As-New starts a fresh history while passing forward the state needed to continue.

- <https://docs.temporal.io/workflow-execution/event>

Overcenter can often avoid that burden. If safe continuation is represented explicitly as compact current state, there is no need to replay every prior command, heartbeat, or decision merely to resume work.

## The minimum durable Overcenter state

A useful storage taxonomy has six durability classes.

| Class | Minimum durable content | Why it must survive |
| --- | --- | --- |
| **Authority** | Exact GitHub project graph/current revision and required external authoritative coordinates | Determines what is true now |
| **Current execution** | Subject, fencing/authority epoch, active lease, exact authority revision, expiration, current checkpoint/continuation | Determines who may act and how interrupted execution resumes |
| **Unresolved operation** | Idempotency identity, request hash, mutation uncertainty, recovery payload, partial effect coordinates | Required while an effect is `prepared` or `indeterminate` |
| **Transition proof** | Exact authority coordinates, transition identity/fingerprints, disposition, evidence refs/hashes, settlement time | Justifies why a settled transition was valid |
| **Effect dedupe** | Idempotency scope/key, request hash, terminal outcome and effect/result identity | Prevents old requests from causing duplicate irreversible effects |
| **Semantics identity** | Contract/schema/derivation/version or content hash used to interpret evidence | Prevents historical receipts from silently changing meaning as code evolves |

Everything else should have to justify indefinite retention.

## Current Overcenter architecture already points this way

Point-in-time live-runtime inspection on 2026-09-02 showed that the newer compact kernel is already substantially aligned with this model.

### `execution_state` is the right shape

`execution_state` held only two rows at the observation point. It stores compact current execution authority:

- subject identity and kind;
- authority/fencing epoch;
- active lease and run;
- exact authority repository/revision;
- graph and transition fingerprints;
- expiry and hard expiry;
- current checkpoint and checkpoint hash;
- bounded recent progress hashes;
- continuation and continuation hash/fingerprint;
- no-progress streak.

The project-transition settlement path moves useful continuation forward and clears active execution material. This is a snapshot/checkpoint architecture without requiring event replay.

Relevant implementation:

- `lib/project-transition-lease-store.js`
- `migrations/053_execution_state.sql`

### `operation_state` is the recovery frontier

`operation_state` held 16 rows at the observation point. Its important role is not historical narration. It represents provider operations whose exact effect may still need to be established, plus terminal identity sufficient for replay/dedupe.

The compact provider operation store explicitly distinguishes:

- `prepared`;
- `indeterminate`;
- `succeeded`;
- `no_effect`;
- `rejected`.

Recovery payload is retained while recovery is necessary and cleared on terminal success/no-effect resolution.

Relevant implementation:

- `lib/compact-provider-operation-store.js`
- `migrations/054_operation_state.sql`

### `proof_state` is the durable proof spine

`proof_state` held four rows at the observation point. It binds a proof identity to:

- subject;
- predicate kind;
- exact authority repository and revision;
- evidence hash;
- evidence references;
- satisfaction time;
- optional consumption time.

This is the sort of append-only history that is worth keeping. The point is not that an invocation happened. The point is that a predicate was proven at an exact authority.

Relevant implementation:

- `lib/compact-proof-state-store.js`
- `migrations/055_proof_state.sql`

### Recovery no longer needs command replay

`lib/orchestration-recovery.js` derives recovery from current durable state:

```text
orchestration_runs current row
        +
execution_state current authority
        +
unresolved operation_state
        +
current legacy lease, when still applicable
```

The implementation identifies its worker-state source as `derived_from_compact_current_state`.

This is a crucial architectural property. Recovery does not require replaying `orchestration_command_invocations`.

### `project.inspect` recomputes project truth

`project.inspect` reads the authoritative GitHub graph, requires a full exact Git SHA, evaluates the project horizon from that graph, and adds current transition occupancy.

Relevant implementation:

- `lib/project-inspect-github-runtime.js`
- `lib/project-inspect-overcenter-host.js`
- `lib/project-horizon.js`

That means READY/DONE/frontier truth is derivable from repository authority and current occupancy. Historical selection logs do not need to become a second source of graph truth.

### The command journal is already declared non-authoritative

`lib/orchestration-journal.js` wraps journal writes in best-effort error handling and explicitly treats journal/run-activity persistence as non-authoritative observability. Current-failure recording is similarly allowed to reduce automation quality without authorizing unsafe work.

That declaration should become a retention policy.

## Point-in-time storage profile

The live database contained the following counts during the research pass:

| Table | Rows observed | Correctness role | Recommended direction |
| --- | ---: | --- | --- |
| `orchestration_command_invocations` | 9,506 | Mostly observability; 3 `running` | TTL terminal rows aggressively |
| `orchestration_runs` | 995 | 3 active, 992 finished | Compact finished runs to a small receipt or TTL |
| `work_leases` | 1,651 | 7 active; substantial legacy recovery coupling | Migrate terminal semantics, then compact |
| `scheduled_cycle_events` | 1,472 | Scheduling history/diagnostics | Materialize current cycle state; TTL events |
| `github_changeset_receipts` | 1,258 | Dedupe/recovery/proof | Keep compact terminal receipt; erase terminal working payload |
| `work_lease_checkpoints` | 430 | Latest checkpoint matters for recovery | Keep latest live checkpoint plus short dedupe tombstones |
| `orchestration_horizons` | 280 | Selection/checkpoint state | Keep active/latest state only; old generations are telemetry |
| `work_lease_heartbeats` | 89 | Lease extension/idempotency | Fold necessary state forward; TTL details |
| `proof_state` | 4 | Exact-revision proof | Keep |
| `execution_state` | 2 | Current compact authority | Keep |

The command-journal outcome distribution was:

- succeeded: 8,634;
- failed: 485;
- rejected: 375;
- indeterminate: 9;
- running: 3.

Of 995 orchestration runs, 992 were finished.

Of 1,651 work leases:

- settled: 1,458;
- expired: 172;
- invalidated: 8;
- rejected: 6;
- active: 7.

The database is therefore dominated by terminal history rather than live recovery frontier.

## What can become disposable telemetry

### 1. Terminal orchestration command journal rows

This is the safest first compaction target.

Once an invocation has no unresolved effect, no active execution dependency, and no unique evidence needed by a terminal receipt, the detailed journal row is observability.

The strongest test is already provided by the code: if journaling can fail without changing authorization, then terminal journal retention cannot be a hidden prerequisite for correctness.

Keep short retention for debugging, metrics, and incident analysis. Do not make indefinite retention part of the product kernel.

### 2. Finished-run working state

An active run needs budget, target, current subject, current failure, and unresolved-operation coordinates.

A finished run does not need to preserve every mutable field forever. Seal a compact terminal run receipt containing the small subset needed for correlation and audit, then delete or TTL the working row after the required operational window.

`migrations/056_orchestration_run_compaction.sql` already points in this direction.

### 3. Historical horizons

A horizon is a decision/checkpoint artifact, not project authority. `project.inspect` can recompute the current frontier from exact Git authority.

For active execution, the latest horizon may be useful for continuation. Once a run is terminal, historical horizon generations are diagnostics unless a specific terminal receipt refers to one.

### 4. Historical heartbeats

Once these facts have been folded into current state:

- current expiry;
- hard expiry;
- last heartbeat time;
- heartbeat count if operationally useful;
- a bounded recent-progress window;

there is no correctness reason to retain the full heartbeat stream forever.

The compact project-transition implementation already keeps only bounded recent progress.

### 5. Superseded checkpoint bodies

Recovery generally needs the latest durable checkpoint, not every checkpoint ever emitted.

The complication is idempotency: old checkpoint requests may currently be replayable by key. Solve that with compact idempotency tombstones rather than retaining every full historical checkpoint body.

### 6. Scheduled-cycle event history

Scheduling/event rows should feed a current materialized cycle state and bounded operational metrics. Once a cycle is conclusively terminal and no recovery decision depends on individual historical events, the detailed event stream should expire.

### 7. Read projections and dashboard snapshots

Preview cards, status rollups, cached counts, search projections, and dashboard materializations should all be rebuildable from the correctness kernel and external authority.

If any such projection becomes necessary to decide whether a mutation is safe, promote the necessary fact into an explicitly durable kernel record instead.

## Work leases require migration before deletion

The 1,651 `work_leases` rows are tempting but are not uniformly disposable yet.

Legacy work execution still reads historical settled/expired leases for:

- continuation packets;
- idempotent claim/settlement replay;
- expired-lease recovery;
- claim/settlement receipts.

Relevant implementation:

- `lib/work-leases.js`

Deleting terminal legacy leases today would therefore change behavior.

The project-transition path demonstrates the destination architecture:

```text
large mutable lease row
    |
    +-- while active -----> current execution_state
    |
    +-- uncertain effect -> unresolved operation_state
    |
    +-- continuation -----> current continuation
    |
    +-- settled ----------> compact terminal receipt
                             + idempotency tombstone

old working lease row
             |
             v
          disposable
```

A lease should be a working transaction record, not a permanent biography.

The migration should move legacy work execution onto the same compact primitives before introducing lease-history TTLs.

## Provider receipts should shrink after terminal settlement

Specialized provider receipt tables are not merely logs because they carry retry/recovery identity around uncertain mutations.

For example, at the observation point `github_changeset_receipts` contained 1,256 succeeded rows and only two prepared rows.

While a changeset is unresolved, the row legitimately needs enough state to recover:

- complete semantic request identity;
- attempt identity;
- old head/base coordinates;
- created tree/commit coordinates;
- mutation phase;
- uncertainty/readback information.

After success, much of that working state is unnecessary.

A terminal changeset receipt can approach:

```text
repo
idempotency_key
request_sha256
old_head
new_head / commit_sha
effect/result hash
terminal outcome
receipt schema/version
settled_at
```

Then erase full request JSON, attempt tokens, heartbeat/phase state, and other recovery-only payload.

Apply the same state-dependent rule to release, promotion, and reconciliation receipts:

```text
PREPARED / INDETERMINATE
    retain recovery-complete record

SUCCEEDED / NO_EFFECT / REJECTED
    seal compact receipt
    retain dedupe identity
    erase recovery-only payload
```

Longer term, if `operation_state` becomes the universal provider-mutation transaction primitive, some specialized receipt state machines may be deletable entirely. That should be a separate kernel-unification effort rather than being mixed into basic retention cleanup.

## Settled project transitions need proof, not narrative

To justify a settled transition later, Overcenter does not need the whole command trace.

It needs enough immutable coordinates to prove something like:

```text
At Git authority revision A:
    transition T had definition D
    dependencies had identity/fingerprint X
    required predicate proofs P were satisfied
    execution held authority epoch E
    resulting effect/result was R

Overcenter accepted settlement S

The resulting authority became B
    or the transition otherwise settled with disposition Q
```

A compact immutable settlement receipt can carry those coordinates.

For graph amendments, later changes must never reinterpret old settlement. Historical receipts should pin the exact Git revision and/or immutable transition/dependency fingerprints that defined the transition at settlement time.

Git already stores the historical graph objects. Overcenter only needs the causal bridge:

```text
Git SHA A
  + exact transition identity
  + verification evidence
  + execution fence
       |
       v
 settlement receipt
       |
       v
Git SHA B / settled disposition
```

That bridge is the durable proof spine.

## Restart recovery is not disaster recovery

A useful boundary is to separate two requirements that event-sourcing discussions often blur:

1. **restart/reconciliation recovery**: recover an interrupted operation from current authority, compact execution state, unresolved operations, and checkpoints;
2. **database disaster recovery**: restore PostgreSQL through normal backup/PITR mechanisms.

Overcenter should not require replaying business events from genesis merely to reconstruct the database after storage loss. Doing so would quietly turn the product into event sourcing by another name.

Correct backups, WAL/PITR, and infrastructure recovery should solve storage disaster. The application-level proof spine should solve semantic recovery and audit.

## Settlement should be a compaction barrier

The safest architectural rule is to make terminal settlement the moment at which working history can be reduced.

A mutation/transition is not fully sealed until the transaction has durably produced:

- canonical current authority or post-state coordinates;
- immutable proof/receipt;
- dedupe identity/tombstone;
- any continuation needed by future execution;
- no unresolved mutation ambiguity.

Only after those closure conditions are true may compaction erase working history.

This gives Overcenter a useful invariant:

> **No row may be compacted while it contains the only durable copy of a fact required for authority, recovery, duplicate rejection, or settlement justification.**

## A mechanical durability test

Before allowing a persisted field or row to survive indefinitely, require it to answer at least one of these questions:

1. Without this value, can Overcenter still determine **current authoritative project state and exact revision**?
2. Can it determine **whether unfinished work may safely resume, and under which fence**?
3. Can it distinguish **no effect, completed effect, and indeterminate mutation** after a crash?
4. Can it reject a **stale or duplicate invocation** that might otherwise repeat an external effect?
5. Can it explain **why a settled transition was valid against its exact prior authority and evidence**?
6. Can it still interpret the historical receipt after **contracts, graph definitions, or code evolve**?

If all six answers remain yes after deleting an item, that item is telemetry.

## Recommended implementation sequence

### 1. Declare durability roles in the schema/code

Give every persistent structure one primary role:

- `authority`;
- `frontier`;
- `proof`;
- `dedupe`;
- `telemetry`.

Treat ambiguous classification as a design smell.

### 2. Add a destructive compaction equivalence test

Build a test fixture that:

1. creates representative successful, failed, retried, expired, and indeterminate executions;
2. records the externally authoritative state and expected `project.inspect`, recovery, duplicate-rejection, and proof results;
3. deletes all rows classified as terminal telemetry;
4. reruns the same inspections and safety decisions;
5. requires identical correctness outcomes.

The first version should deliberately delete:

- terminal command-journal rows;
- old heartbeat rows;
- superseded checkpoints;
- finished-run projections;
- obsolete horizon generations;
- dashboard/preview materializations.

Whatever breaks identifies either accidental correctness-critical telemetry or a compact fact that has not yet been promoted into the kernel.

### 3. TTL the command journal first

The command journal is already explicitly non-authoritative and is the clearest high-volume target.

Start with a conservative retention window for terminal rows. Never TTL unresolved `running`/`indeterminate` entries merely by age until their authoritative effect has been reconciled.

### 4. Compact finished orchestration runs

Seal a small run receipt, keep only the correlation/evidence fields required by support and audit, and remove mutable working fields after a bounded retention period.

### 5. Migrate legacy work leases to compact execution primitives

Move continuation, fencing, checkpoint, idempotency, and terminal proof semantics out of historical lease rows and into `execution_state`, `operation_state`, proof/receipt records, and dedupe tombstones.

Only then introduce terminal lease compaction.

### 6. Compact provider receipts by state

Keep recovery-complete records only while operations can still be uncertain. Rewrite terminal provider receipts into a sealed minimal form.

### 7. Treat every read-side cache as disposable by construction

Add rebuild paths and tests for preview/status/materialized views. Fail code review when a projection becomes the sole durable source for a correctness decision.

## Architectural pressure test

The desired durable kernel becomes conceptually small:

```text
GitHub
  canonical project graph + immutable revision history
          |
          v
+--------------------------------------------+
| Overcenter correctness kernel              |
|                                            |
| execution_state     current fenced state   |
| operation_state     unresolved effects     |
| proof_state         immutable evidence     |
| transition_receipt  immutable settlement   |
| effect_tombstone    duplicate prevention   |
+--------------------------------------------+
          |
          v
+--------------------------------------------+
| Disposable surfaces                        |
|                                            |
| journals, horizons, command traces         |
| heartbeats, old checkpoints, dashboards    |
| preview/status projections, aggregates     |
+--------------------------------------------+
```

This aligns with the central Overcenter product boundary: deterministic software owns execution correctness, while reasoning agents make judgments. Durable storage should encode execution truth, not preserve every incidental step an agent or operator took on the way there.

## Caveats and follow-up questions

- The live compact kernel inspected during this research was ahead of some previously observed GitHub source surfaces. Before implementing retention, verify that the repository revision intended for deployment contains the compact recovery/proof primitives and that runtime/source drift is resolved.
- Legacy `work_leases` remain a correctness dependency today and cannot be blindly TTL'd.
- Idempotency tombstone retention needs an explicit horizon. “Forever” is safe but potentially unnecessary; a shorter horizon requires a provider-by-provider argument that old requests cannot reappear and cause irreversible duplicate effects.
- Compliance/audit retention may require keeping more data than execution correctness requires. That should be a separately named policy tier, not hidden inside the transaction kernel.
- Proof/evidence references must themselves remain resolvable for as long as settled transitions are expected to be auditable.

## Core recommendation

Do not ask, “Which events should Overcenter retain?”

Ask:

> **What is the minimum durable information that makes the next safe decision mechanically knowable?**

Keep that information. Seal it at settlement. Treat everything else as a projection with an expiration date.