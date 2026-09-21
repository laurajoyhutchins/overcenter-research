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

The deterministic scripted worker is a control for the transaction harness, not evidence that a hostile reasoning process is physically contained. A model-backed worker is not admitted to a sandbox stage until it runs through an already-proved confinement profile (or an equivalently strict disposable environment) with synthetic project bytes, no provider or repository mutation credentials, and no ambient path to production authority. The worker never receives Overcenter's execution capability or authority database.

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

Stages may be run with a scripted worker first to prove the machinery. Those runs are labeled `scripted-control` and do **not** satisfy the autonomy capability claim or promotion gate. The same stage must subsequently pass with an uncertain reasoning worker under admitted confinement without changing the authority topology.

### Current Stage 1 control

`npm run experiment:autonomy-sandbox` runs the Stage 1 transaction with an explicit reproducible seed. It copies the synthetic fixture into a fresh temporary directory, creates a fresh SQLite authority database, claims one migration obligation, launches a fresh worker process with a credential-free environment, independently runs the fixture verifier, writes the only settlement attestation outside the worker workspace, settles through Overcenter, reconstructs the result from a fresh kernel, emits one JSON evidence record, and deletes the temporary sandbox. A paired no-op-worker negative control must remain non-DONE.

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

## First uncertain-reasoning witness

The first Stage 1 reasoning pass is retained under `model-witness/`. Codex Cloud received only the synthetic source text in the prompt and returned structured candidate JSON. The request explicitly prohibited repository/provider mutation; the observed branch head did not change across the request and response.

That candidate passes the same independent synthetic verifier and Overcenter settlement path as the scripted control. The evidence is classified `uncertain-reasoning-stage1`, not promotion-ready. Provider-side reasoning confinement remains unproven, so the stronger harmless-worker claim still requires a worker whose mutation capability is physically absent rather than merely unused.


### Recorded uncertain-model Stage 1 witness

The first uncertain reasoning witness uses Codex Cloud only to produce candidate bytes. Request comment `5756705966` asked for reply-only JSON and prohibited repository/provider mutation; response comment `5756716623` returned the candidate. The branch head remained exactly `c448001cbad04c502b21fee6e52a961b5d326801` before and after the reasoning response.

The candidate is retained as inert data in `sandbox-candidate-codex.json` and bound to the live request/response by `sandbox-candidate-codex.provenance.json`. CI re-fetches both comments read-only and requires the prompt digest, full response digest, response author, first-line candidate bytes, candidate digest, and unchanged reasoning-time branch head to agree.

Codex does not settle anything. Trusted sandbox software admits only the exact declared write/delete set, applies those bytes to a disposable fixture, and runs the resulting verifier through the production `overcenter-exec` Rust confinement boundary before minting the settlement attestation. The authority database and execution capability remain outside the worker workspace.

This is stronger evidence about reasoning usefulness, but it is still not promotion evidence: Codex Cloud's provider-side repository capability is not independently proven absent, the reasoning invocation is recorded external evidence rather than replayable from repository state alone, and fault-recovery stages remain unexercised.

## Credential-free local reasoning worker

The stronger Stage 1 witness runs a pinned public Qwen2.5-Coder 0.5B GGUF model with a pinned llama.cpp CPU runtime in a disposable GitHub-hosted worker job. Model and runtime bytes are SHA-256 checked before use. Immediately before inference, the process is launched through a fresh Linux network namespace with an empty environment; it receives a local model file, prompt, and JSON schema only.

The model job has read-only repository permission and an ephemeral checkout with no persisted credential. Its only retained output is candidate/provenance artifact bytes. A separate fresh runner applies those bytes to a new synthetic workspace and performs independent Overcenter verification and settlement. The model process never receives the authority database, execution permit, verifier attestation path, or settlement capability.

This is the intended harmless Stage 1 worker boundary. Passing it establishes the bounded single-obligation reasoning capability; promotion remains a separate reviewed action and later fault/recovery stages remain required for broader autonomy claims.


## AI SDK reasoning route

The sandbox uses one model-selection seam rather than teaching Overcenter provider-specific inference APIs:

```text
reasoningModel(profile)
  default     -> AI Gateway model string
  google-free -> direct @ai-sdk/google model
```

Both routes feed the same candidate schema and the same independent admission, confined execution, verification, settlement, and reconstruction machinery. The route changes how reasoning is funded and transported; it does not change what counts as project truth.

The `google-free` profile requires `GOOGLE_GENERATIVE_AI_API_KEY`. The manual `Autonomy sandbox Google-free AI SDK proof` workflow copies only the trusted AI SDK client, model resolver, synthetic prompt, and candidate schema into a disposable runtime, removes the repository checkout, drops to an unprivileged UID, and performs one networked Gemini inference. The model worker has inference authority but no repository credential, Overcenter authority database, or project-provider mutation authority.

Because direct Gemini inference requires networking, this route does **not** claim offline process confinement. Its retained evidence instead requires `reasoning_authority_confinement_proven=true`, while candidate execution remains independently confined by `overcenter-exec`.

A successful run is still non-promotable. It proves only that an AI SDK-selected uncertain reasoner can produce one useful Stage 1 candidate without gaining authority to decide or publish the resulting project state.
