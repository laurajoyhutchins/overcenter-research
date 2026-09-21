# Operator commands

Overcenter operator commands are a narrow semantic control surface for environments that can rerun GitHub Actions jobs but cannot expose a custom Overcenter tool.

The interface is intentionally not a generic command bus.

```text
reasoning session
      |
      | rerun one named job
      v
Overcenter command anchor
      |
      | typed semantic command
      v
provider mutation adapter
      |
      | attributable provider identity
      v
command receipt
```

## Contract

A command has three distinct identities:

1. **Semantic command** — a stable name such as `candidate.certify`.
2. **Command invocation** — the GitHub workflow run ID and rerun attempt that requested it.
3. **Provider result** — the concrete workflow run created by the command.

The rerun is transport only. GitHub Actions YAML does not decide what `candidate.certify` means. `src/github-operator-command.ts` owns that mapping and returns a typed receipt.

The current receipt schema is `overcenter-github-operator-command/v1`. Schema versions live in explicit metadata; ordinary command names remain stable.

## candidate.certify

For every same-repository pull-request head, `.github/workflows/operator-commands.yml` creates one inert job:

```text
command · candidate.certify
```

Its first run only advertises that the command is available. Rerunning that exact job invokes the command.

The command derives all coordinates from the original pull-request event:

- repository identity;
- pull request number;
- exact advertised head SHA;
- head branch ref;
- command workflow run ID;
- command rerun attempt.

It accepts no free-form command payload.

On invocation, the trusted adapter dispatches `merge-gate.yml` for the captured branch ref and passes the captured head SHA as `source_sha`. The merge gate independently requires the dispatched run's actual source SHA to equal that requested SHA. A moved branch therefore fails closed rather than silently certifying newer code.

GitHub Cloud's workflow-dispatch response provides the new workflow run ID and URLs. The command receipt records those values and a canonical receipt digest. Successful dispatch is not equivalent to successful candidate evidence; callers must observe the dispatched run separately.

## Authority and permissions

The top-level workflow has no permissions. The individual `candidate.certify` anchor receives only:

```yaml
actions: write
contents: read
```

The command is unavailable for cross-repository pull-request heads. Repository contents are checked out only on invocation, at the exact advertised source SHA, with persisted checkout credentials disabled.

The command surface does not use issue comments, pull-request comments, reviews, labels, commits, or branch mutations as transport.

## Extension rule

Add a new command only when it can be expressed as a narrow semantic operation with deterministic coordinates and an attributable provider result.

Each new command should have:

- one stable semantic command name;
- one visible rerunnable job anchor;
- a deterministic adapter implementation;
- the minimum provider permission required by that command;
- an exact subject/revision fence;
- a typed receipt containing the provider result identity;
- tests proving that the first run is inert and that unsupported or ambiguous results fail closed.

Do not add an `exec`, arbitrary REST, arbitrary workflow-name, or free-form JSON command. If a family of commands starts accumulating mechanically derivable bookkeeping, move that bookkeeping into software rather than asking the caller to construct it.
