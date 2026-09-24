# Substrate capability admission

## Question

Can machine-readable substrate capability evidence safely affect admission without confusing an untrusted environment description with proof?

This experiment starts from two prior results rather than trying to re-prove them:

- `ambient-authority-boundary` established that project-truth confinement and physical effect confinement are distinct;
- the production Rust confinement proof established strong physical confinement where Overcenter controls the substrate.

Project-truth isolation is therefore a **held-constant prior invariant** here. This experiment tests only admission on a specific provider capability: `github.commit-status.write`.

## Hypothesis

Admission can safely consume authenticated capability evidence without promoting a point observation of absence into an execution guarantee. Controlled isolation may authorize confinement-sensitive work; observed absence is informational only. Authority-bearing evidence must be:

1. issued by a trusted authority rather than self-declared;
2. cryptographically authenticated;
3. bound to the exact substrate instance;
4. bound to the exact capability;
5. bound to the exact source revision, execution, and admission epoch.

```text
untrusted descriptor
        |
        | cannot mint
        v
signed capability evidence
  substrate + capability
  revision + execution + epoch
        |
        v
      admission
```

The descriptor is metadata. The evidence envelope is authority-bearing only after signature and context verification.

## Fixtures

| Fixture | Descriptor claim | Trusted observation used by the hosted proof |
| --- | --- | --- |
| A `controlled-sandbox` | isolated | production Rust confinement proof passes |
| B `foreign-status-write-denied` | absent | this GitHub token receives 403 for commit-status mutation |
| C `foreign-ambient-status-write` | ambient write | the same mutation returns 201 with `statuses: write` |
| hostile liar | isolated | trusted probe observes the capability present |

B is intentionally narrow. It does **not** claim "no provider credentials." A 403 proves only that the tested credential lacks `github.commit-status.write` at that observation epoch.

## Preregistered matrix

| Requirement | A | B | C | hostile liar |
| --- | ---: | ---: | ---: | ---: |
| status-write unconstrained | accept | accept | accept | accept |
| status-write absent throughout execution | accept | reject | reject | reject |
| controlled status-write isolation | accept | reject | reject | reject |

Observed absence is weaker than controlled isolation and is deliberately non-authorizing for a mutable foreign substrate.

## Preregistered hostile controls

The experiment must reject all of these:

- descriptor claims isolation while trusted evidence says the capability is present;
- signed evidence with its guarantee modified after signing;
- an attacker signing data while merely claiming the trusted issuer name;
- valid evidence for the wrong substrate;
- valid evidence for the wrong capability;
- valid absence evidence from a stale admission epoch;
- valid evidence from a different source revision;
- an unrecognized signed evidence schema;
- a capability probe asserting controlled isolation;
- a controlled-substrate attestor asserting observational absence;
- a point observation of absence used as admission authority.

The descriptor-only matcher remains as a deliberate negative control and must still admit the lying descriptor.

## Run

```sh
npm run test:substrate-capability-admission
```

Routine pull-request CI is read-only with respect to provider status mutation: it runs the deterministic boundary, the Rust confinement proof, and the denied status-write probe.

The positive ambient-write treatment is isolated in `.github/workflows/substrate-capability-admission-treatment.yml` and is `workflow_dispatch` only. It exists for deliberate reproduction of the already-observed HTTP 201 treatment without leaving `statuses: write` in ordinary PR CI.

## Falsification conditions

The hypothesis is falsified if any hostile control above is admitted, if B's point observation authorizes an absence requirement, if C is admitted when confinement is required, or if the admission relation requires substrate-specific branches rather than exact capability evidence.

## Interpretation boundary

A positive result supports the **evidence contract and admission algebra** for one concrete provider capability. It supports positive rejection from observed ambient authority and positive admission from controlled-isolation attestation. It deliberately does not support admission from point-in-time absence on a mutable foreign substrate.

The experiment also does not claim that the test harness's ephemeral Ed25519 key custody is the production attestation mechanism. Production promotion must preserve the same trust-root separation and context binding while choosing the actual attestor/key custody boundary.

## Non-claims

This experiment does not claim that:

- project-truth isolation is re-proven here;
- a failed provider request proves all provider-write capabilities are absent;
- an admission epoch automatically advances when a foreign substrate's real capabilities change;
- observations remain true after their admission epoch;
- a worker can attest its own confinement;
- every capability can be discovered by probing;
- the tested capability taxonomy is complete;
- scheduler integration is justified before this exact experiment is evaluated.
