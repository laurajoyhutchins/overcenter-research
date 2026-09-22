# Closed-loop Actions command proof

## Question

Can a reasoning agent operate Overcenter through a productized GitHub Actions command surface without receiving execution authority, constructing provider coordinates, or reporting its own success?

## Hypothesis

A complete bounded loop can be expressed as two semantic choices:

```text
project.advance
      |
      | deterministic execution first
      v
AGENT_EXECUTION_REQUIRED
      |
      | reasoning agent authorizes one advertised action
      v
work.execute
      |
      | Overcenter reacquires hidden execution authority
      | reserves the predeclared effect
      | mutates the provider
      | observes authoritative reality
      | settles the exact run
      v
project.advance
      |
      v
IDLE
```

The agent receives a capability-free `Work` packet. It never receives an `ExecutionPermit`, GitHub mutation coordinates supplied outside authority, or a free-form execution payload.

## Deterministic contract

Run:

```sh
npm run test:project-advance
```

The local regression proves four distinctions:

1. A known deterministic effect runs before any agent handoff.
2. Work marked `agent-authorization/v1` reaches `WAITING` before effect reservation and exposes only the semantic action `work.execute`.
3. An unsatisfied WAITING postcondition remains WAITING under `project.advance`; it does not become `RECOVERY_REQUIRED` merely because the requested action has not happened yet.
4. Either `work.execute` or an independently performed one-off action can close the same run, but only authoritative observation can produce `DONE`.

## Hosted witness

The hosted proof uses Git only as the **reference durable-fact backend** on the isolated ref:

```text
refs/overcenter/closed-loop
```

This is deliberate. The repository's production reference path is SQLite; the hosted Actions experiment does not claim that Git is the production authority store.

When this experiment's seed descriptor changes on `main`, `closed-loop-seed.yml` reconciles one obligation whose postcondition is:

- provider: GitHub;
- object: the exact trusted merge commit;
- context: `overcenter/closed-loop-witness`;
- expected state: `success`.

The obligation carries the production commit-status effect contract plus the explicit policy `agent-authorization/v1`.

The hosted sequence is:

1. Rerun the latest `project.advance` command job.
2. Read the dispatched run's `overcenter-project-advance-*` artifact.
3. Require `AGENT_EXECUTION_REQUIRED`, the exact WAITING run identity, and `allowed_actions: ["work.execute"]`.
4. Rerun the latest `work.execute` command job.
5. Read the dispatched run's settlement artifact and require `DONE` with verified evidence.
6. Rerun `project.advance` once more and require `IDLE`.

## Falsifiers

The hypothesis fails if any of the following occurs:

- `project.advance` exposes an execution capability or provider credential to the agent packet;
- the authorization-gated effect is reserved or invoked before `work.execute`;
- the agent can supply or alter repository ID, commit SHA, status context, desired state, authority ref, run ID, or effect contract through command transport;
- rerunning a stale command anchor executes against a newer default-branch revision;
- `work.execute` can act on non-WAITING work or a packet that did not predeclare the supported effect;
- provider mutation can settle `DONE` without independent postcondition observation;
- an unsatisfied WAITING readback is rewritten as retryable or recovery state;
- the final `project.advance` is not `IDLE` after verified settlement.

## Interpretation

A passing hosted witness establishes the missing interface loop for this bounded provider effect:

```text
authoritative graph
      -> deterministic advance
      -> bounded agent judgment
      -> semantic authorization
      -> deterministic effect execution
      -> authoritative observation
      -> settlement
      -> next graph state
```

It demonstrates that an agent can interact with Overcenter similarly to an ordinary operator without bespoke GitHub CRUD.

## Non-claims

This experiment does not establish that:

- Git is the production authority backend;
- every provider effect can be represented by `work.execute`;
- every ambiguity can be resolved by an agent;
- arbitrary one-off agent procedures are safe merely because they were chosen by an agent;
- GitHub Actions rerun transport is the only or final operator interface;
- the current single commit-status effect constitutes a generic provider adapter.

The intended product boundary remains: deterministic software owns execution correctness; reasoning agents are invoked only where judgment remains.
