# Project intent

`.overcenter/project-intent.json` is trusted input to `project.advance`. It expresses desired obligations, not execution choreography.

The authoritative compiler is [`src/authority/project-intent.ts`](../src/authority/project-intent.ts). The current schema discriminator is `overcenter-project-intent/v1`.

## Shape

The file has exactly two top-level fields:

    {
      "schema": "overcenter-project-intent/v1",
      "obligations": [ ... ]
    }

Each obligation has:

| Field | Meaning |
| --- | --- |
| `id` | stable project-facing obligation identifier |
| `task` | immutable pure-candidate work packet definition |
| `postcondition` | deterministic acceptance predicate compiled into the obligation |
| `dependencies` | optional control or semantic dependencies |

The current task shape is exact-key validated:

    {
      "command": ["node", "task.ts", "input.txt", "result.txt"],
      "required_paths": ["task.ts", "input.txt"],
      "output_path": "result.txt"
    }

The checked-in [`.overcenter/project-intent.json`](../.overcenter/project-intent.json) is a live example.

## What the file does not contain

Project intent deliberately does not name:

- the current authority head;
- a claim, lease, run, or execution generation;
- a source SHA supplied by the producer;
- settlement authority;
- provider credentials;
- a scheduler priority or chosen worker.

`project.advance` derives dynamic authority and source identity from the trusted command context. This keeps a declarative producer from smuggling execution authority into desired state.

## Reconciliation semantics

The file is an ensure-set. Obligations present in the file are compiled and reconciled through the ordinary graph/admission boundary. Omission is not deletion: a partial project-intent file does not retire unrelated existing obligations.

Admission still owns graph safety. Invalid dependencies, cycles, unsupported semantic selectors, missing settlement semantics, and statically knowable conflicting effects fail before they become executable project truth.

## Changing intent

A material change to a task, dependency, or postcondition changes semantic identity. Historical execution is reusable only if current realization-reuse rules can prove that the retained realization still satisfies the new exact obligation.

Do not preserve identity cosmetically by hiding material inputs outside the obligation. If a value can change whether a result is acceptable, it belongs in semantic identity or in authoritative observation.
