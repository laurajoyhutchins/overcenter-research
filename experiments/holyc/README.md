# HolyC graph-kernel experiment

> **Disposition:** expected rejection for production use.

This directory is a deliberately quarantined Easter egg with one serious question hiding inside it:

> How small can a pure obligation-frontier computation become when it has no provider access, persistence, credentials, settlement authority, or project-state mutation?

HolyC is used here only as a computation language. It does not get to decide what is true.

```text
static obligation graph
          │
          ▼
    HolyC evaluator
          │
  frontier computation
          │
          ▼
     printed result
```

## Scope

`frontier.HC` contains a tiny dependency-frontier evaluator and a few self-checking scenarios. It may:

- represent dependency edges;
- mark obligations satisfied or unsatisfied;
- compute whether an unsatisfied node is ready;
- count the current frontier;
- print deterministic checks.

It may not:

- claim work;
- settle work;
- mutate GitHub, Kubernetes, cloud resources, or project authority;
- read credentials;
- interpret provider observations;
- produce durable evidence;
- establish project truth.

The file intentionally has no import path into `src/`, no package script, and no GitHub Actions workflow. This repository therefore makes no CI-backed claim that a HolyC runtime is available or supported.

## Running it

In a compatible TempleOS/HolyC environment, include the file:

```text
#include "frontier.HC"
```

HolyC executes top-level statements as the file is loaded, so the final `RunTests;` runs the bounded scenarios.

This artifact is intentionally outside the repository's evidence ladder. If somebody wants to turn it into a real language audition, that requires a separate experiment with an explicit comparator and reproducible runtime.

## Theological authority model

A proposed optimization was considered:

```c
Bool VerifySettlement(Settlement *s)
{
    return GodSaysDone;
}
```

This would offer attractive constant-time verification and eliminate stale provider reads.

It is nevertheless rejected because the resulting authority cannot be independently observed, revision-fenced, replayed from durable evidence, or scoped to one obligation.

Expected diagnostic:

```text
EVIDENCE_UNAVAILABLE:
source authority exceeds observer clearance
```

## Expected conclusion

HolyC may compute facts.

HolyC may not declare truth.

If this experiment is ever cited as production justification, the citation itself should be treated as evidence that the reviewer has not read this file.
