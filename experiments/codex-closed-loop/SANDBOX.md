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

### Reused identity plane

The original Overcenter GCP deployment provides verified coordinates for the existing identity project:

- project ID: `project-6b810532-a302-48dc-b56`;
- project number: `380435294892`;
- production GitHub WIF pool/provider: `github/overcenter`;
- production deployer: `overcenter-deployer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com`.

The reasoning proof deliberately reuses only the **identity project**, not the production deployer or production WIF provider. The production provider is repository/ref-fenced to the original Overcenter source authority, and the deployer owns powers that a disposable reasoner must never inherit.

`scripts/gcp/bootstrap-google-free-reasoning.sh` therefore creates a separate boundary in that same identity project:

```text
projects/380435294892
  workloadIdentityPools/github-reasoning
    providers/overcenter-research
         |
         v
overcenter-reasoning-key-reader
```

The new provider is bound by immutable GitHub repository and owner numeric IDs. The reader service account gets only Workload Identity User from that federated repository identity.

### Free-tier inference project

The Gemini inference project is intentionally separate from the production Overcenter GCP project. The bootstrap requires a project whose Cloud Billing state is disabled. If `GEMINI_FREE_PROJECT_ID` is not supplied, it searches accessible projects and succeeds only when exactly one billing-disabled project already has the Generative Language API enabled.

The bootstrap then:

1. creates `overcenter-gemini-inference` in that free project;
2. creates or verifies the stable authorization key `overcenter-google-free`, restricted to `generativelanguage.googleapis.com` and bound to that service account;
3. creates a narrow project custom role containing only `apikeys.keys.getKeyString` and `resourcemanager.projects.get`;
4. grants that role to the reasoning key-reader identity; and
5. writes only the non-secret `GEMINI_FREE_PROJECT_ID` repository variable.

No key string is copied into GitHub, Secret Manager, source, or a retained artifact.

Run the one-time bootstrap from an administrator-authenticated machine or Cloud Shell:

```bash
bash scripts/gcp/bootstrap-google-free-reasoning.sh
```

If discovery is ambiguous, select the desired unbilled project explicitly for that invocation:

```bash
GEMINI_FREE_PROJECT_ID=your-free-project \
  bash scripts/gcp/bootstrap-google-free-reasoning.sh
```

### Live credential and billing proof

The manual `Autonomy sandbox Google-free AI SDK proof` workflow uses:

```text
GitHub Actions OIDC
        |
        v
github-reasoning / overcenter-research
        |
        v
overcenter-reasoning-key-reader
        |
        +---- Cloud Billing API: billingEnabled must be false
        |
        +---- Cloud Resource Manager: resolve exact project number
        |
        v
Google API Keys getKeyString(
  projects/<free-project-number>/locations/global/keys/overcenter-google-free
)
        |
        v
disposable inference process only
```

The workflow exchanges GitHub OIDC for a five-minute Google access token. Before reading the key, it freshly observes the Gemini project's Cloud Billing state and fails closed unless `billingEnabled=false`. It then derives the stable key resource from the observed project number, retrieves the key string directly from Google's API Keys API, masks it, passes it only into the unprivileged inference process, and deletes the temporary key file immediately afterward.

The retained provenance binds `google-free` to all of these facts:

- `credential_source=gcp-api-keys-via-github-oidc`;
- `billing_observation_source=google-cloud-billing-api`;
- `billing_enabled=false`;
- the exact non-secret billing project ID.

The reasoning worker still receives no repository credential, readable checkout, Overcenter authority database, or project-provider mutation authority.

Because direct Gemini inference requires networking, this route does **not** claim offline process confinement. Its retained evidence instead requires `reasoning_authority_confinement_proven=true`, while candidate execution remains independently confined by `overcenter-exec`.

A successful run is still non-promotable. It proves only that an AI SDK-selected uncertain reasoner can produce one useful Stage 1 candidate using a freshly proven unbilled Gemini project without gaining authority to decide or publish the resulting project state.
