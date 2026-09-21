# Autonomy sandbox

This profile is the proving ground for longer-horizon uncertain-agent work. It extends the existing closed-loop experiment without granting the experiment any real project or provider authority.

## Safety boundary

A sandbox run may consume the real Overcenter kernel implementation, but every mutable thing it can affect is disposable:

```text
checked-in synthetic fixture
          |
          v
temporary fixture copy + temporary SQLite authority
          |
          v
uncertain or scripted worker
          |
          v
candidate bytes inside temporary fixture
          |
          v
trusted sandbox verifier
          |
          v
sandbox settlement + evidence report

no production authority database
no repository publication
no provider mutation credential
no branch, PR, issue, status, deployment, or release write
```

The worker may use a model service when the reasoning-worker stage requires one. Harmlessness does not depend on trusting the worker or its network behavior: the worker receives only synthetic project bytes and no credential or API capability that can mutate a real provider.

The sandbox result is evidence only. It cannot promote itself, change production configuration, or become project truth outside its temporary authority store.

## Repeatability contract

Every run records:

- the exact Overcenter source revision;
- the exact synthetic-fixture digest;
- the sandbox profile revision;
- the reasoning-worker identity/configuration when one is used;
- a required experiment seed;
- the derived fault schedule;
- every claimed revision, execution generation, candidate digest, observation, and settlement;
- human interventions as explicit events rather than invisible operator repair.

Fault injection is seed-derived. The same source, fixture, profile, worker configuration, and seed must reproduce the same deterministic fault schedule. Reasoning output itself need not be deterministic; the execution/evidence envelope must be.

## Capability ladder

The stages intentionally reuse one sandbox and add one source of autonomy at a time.

| Stage | Added capability | Bounded success condition |
| --- | --- | --- |
| 1 | one real coding obligation | one nontrivial synthetic migration is independently verified and settled with no human repair |
| 2 | multi-obligation relay | ten useful settlements accumulate across disposable workers using only authoritative state |
| 3 | crash/replacement | injected worker loss at pre-output, post-output, and recovery boundaries produces no false DONE and the objective continues |
| 4 | frontier choice | the worker selects among multiple READY opportunities without receiving project-truth authority |
| 5 | dynamic decomposition | the worker proposes new obligations/dependencies; deterministic admission rejects incoherent or unsafe proposals |
| 6 | repair loop | certified compile/test failures feed follow-up work until the synthetic repository returns to green |
| 7 | sustained campaign | at least 100 useful settled transitions complete with bounded attempts and zero unsafe state transitions |

Stages may be run with a scripted worker first to prove the machinery, then with an uncertain reasoning worker without changing the authority topology.

## Measurements

Every stage reports at least:

- verified useful transitions;
- human judgment interventions;
- attempts per accepted transition;
- automatic recoveries;
- false-DONE count;
- duplicate or unsafe external-effect count;
- objective completion fraction;
- useful settlements per active worker-hour.

The primary supervision metric is:

```text
supervision amplification =
  verified useful transitions / human judgment interventions
```

A zero-intervention run reports the numerator and `0 interventions` rather than pretending the ratio is finite.

## Promotion gate

Sandbox success never flips a runtime flag.

Promotion requires a separate reviewed change that names the capability being promoted and cites exact sandbox evidence. At minimum, promotion evidence must show:

1. zero false DONE transitions;
2. zero writes outside sandbox-owned state;
3. zero unverified or duplicate provider effects;
4. successful fresh-process reconstruction from durable sandbox authority;
5. successful injected-failure recovery for every fault class exercised by the promoted capability;
6. no hidden human bookkeeping needed to repair execution state;
7. reproducible experiment instructions and retained exact evidence identity.

A promoted capability may replace synthetic inputs or local fake effects with real ones only in that later change. The sandbox itself remains harmless after promotion.
