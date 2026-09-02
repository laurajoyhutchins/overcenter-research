# Transition Attestations and Durable Evidence

## Question

What should an Overcenter receipt prove, and which evidence must survive long term versus which execution history can safely be garbage-collected?

For Overcenter, the answer is:

> A receipt should be a compact, immutable, independently verifiable certificate of a project-state transition, not a permanently retained execution transcript.

The conceptual model is:

```text
intent + exact inputs + authority
              |
              v
       execution machinery
      journals / retries / leases
              |
              v
     Transition Attestation
   "this is what actually happened"
              |
              v
       verification/recovery
              |
              v
     Settlement Attestation
  "all effects are now accounted for"
              |
              v
       durable project truth

        journals may now die
```

The key retention principle is:

> Preserve proofs, not exhaust.

Everything required to establish why a project transition was legitimate, what exact state it started from, what effects occurred, how those effects were verified, what exact state resulted, and whether all effects were ultimately accounted for must remain durable. Ordinary orchestration machinery can become disposable once settlement and evidence-retention requirements are satisfied.

## Prior art

### in-toto

The in-toto Attestation Framework provides a useful semantic envelope for Overcenter receipts.

An in-toto Statement binds an immutable `subject` to a typed `predicate`. The subject is identified by digest, while the predicate type lets a domain define its own claim semantics without inventing a new signing envelope for every use case.

Classic in-toto metadata also distinguishes between inputs/materials, outputs/products, and the functionary that performed a step. That distinction maps naturally onto Overcenter transitions.

For Overcenter, the useful lesson is:

```text
subject   = immutable resulting project/resource state
predicate = Overcenter-specific transition facts
```

The subject should not normally be an execution attempt, lease, or worker process. Those are machinery. The durable claim should be about resulting project truth.

References:

- in-toto Attestation Framework Statement v1: https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md
- in-toto project: https://in-toto.io/

### SLSA provenance

SLSA provenance contributes an especially useful separation between the definition of what was supposed to happen and details of the particular execution that produced the result.

Current SLSA build provenance separates concepts such as:

```text
buildDefinition
    external parameters
    resolved dependencies

runDetails
    builder identity
    invocation identity
    timing
    byproducts
```

SLSA deliberately does not require provenance to serialize every ordinary interaction with the build platform's control plane. What matters is information that materially affects or substantiates the result.

That distinction is directly applicable to Overcenter.

A transition receipt should retain semantic inputs, exact resolved dependencies, authority, material effects, verification evidence, and resulting state. It should not preserve every poll, retry, heartbeat, cache read, scheduler wakeup, or duplicate provider response merely because those events occurred during execution.

Reference:

- SLSA Build Provenance v1.2: https://slsa.dev/spec/v1.2/build-provenance

### DSSE

Dead Simple Signing Envelope, DSSE, provides a useful signing envelope for attestations.

DSSE signs a pre-authentication encoding that covers both the payload type and payload bytes. This prevents ambiguity about what kind of object was actually signed.

For Overcenter, the lesson is that the durable receipt should have an explicit predicate type and cryptographically bind the exact serialized attestation that was approved.

Reference:

- DSSE specification: https://github.com/secure-systems-lab/dsse

### Sigstore

Sigstore shows how identity-bound signatures can remain verifiable long after an ephemeral execution identity or short-lived signing credential has disappeared.

Its architecture separates several concerns:

```text
Fulcio   binds a short-lived key to an identity
Rekor    provides transparency-log evidence
bundle   packages material needed for later verification
```

A Sigstore bundle can carry signatures, certificates, timestamps, and transparency-log material so verification does not depend on the original signing session still existing.

This is a strong model for Overcenter receipts. A settled transition should remain verifiable without preserving the original worker process, lease row, Hatchable instance, ephemeral signing key, or execution session.

References:

- Sigstore bundle format: https://docs.sigstore.dev/about/bundle/
- Sigstore architecture: https://docs.sigstore.dev/about/system_config/

### TUF

The Update Framework contributes an important distinction between identity and authority.

Knowing who signed something is insufficient. A verifier must also determine whether that signer was authorized under the trust policy in force at the relevant time.

TUF models trusted roles, keys, thresholds, versions, and trust-root evolution. For Overcenter, this implies that transition evidence should preserve not merely the identity of the actor or executor but the exact authority decision and policy revision under which the mutation was allowed.

Reference:

- TUF specification: https://theupdateframework.github.io/specification/latest/

### SCITT

The IETF Supply Chain Integrity, Transparency, and Trust model provides useful prior art for transparency receipts.

RFC 9943 defines signed statements that can be registered with a Transparency Service. The service can return a cryptographically verifiable receipt proving registration in a verifiable data structure.

This suggests a possible future Overcenter transparency layer: transition attestations could remain Overcenter-native while periodically being externally witnessed or checkpointed without making the transparency service the authority for project truth.

Reference:

- RFC 9943, SCITT Architecture: https://datatracker.ietf.org/doc/rfc9943/

## What Overcenter should borrow

| Prior art | Useful Overcenter concept |
| --- | --- |
| in-toto Statement | Common envelope: immutable subject plus versioned custom predicate |
| SLSA provenance | Separate semantic inputs and dependencies from per-execution machinery |
| DSSE | Sign the predicate with explicit type binding |
| Sigstore | Identity-bound signing plus portable long-term verification material |
| TUF | Versioned authority, scoped roles, thresholds, and trust-root evolution |
| SCITT | Optional append-only registration proof or independent witness |

Overcenter should not call its transition attestation "SLSA provenance." SLSA's schema is intentionally build-specific.

A better approach is to use the in-toto Attestation Framework as the generic envelope, define an Overcenter-specific predicate, and borrow SLSA's provenance modeling disciplines.

## Conceptual Overcenter Transition Attestation

A conceptual attestation could have this shape:

```json
{
  "_type": "https://in-toto.io/Statement/v1",

  "subject": [{
    "name": "overcenter://project/<project-id>/state",
    "digest": {
      "sha256": "<canonical-resulting-state-digest>"
    }
  }],

  "predicateType": "https://overcenter.dev/attestation/transition/v1",

  "predicate": {
    "transition": {
      "id": "<transition-id>",
      "operation": "project.advance",
      "invocationId": "<idempotency-or-correlation-id>",
      "previousAttestation": "sha256:<digest>",
      "startedAt": "<timestamp>",
      "observedAt": "<timestamp>"
    },

    "inputs": {
      "intent": {
        "...": "normalized semantic parameters"
      },

      "preState": {
        "revision": "<exact-overcenter-revision>",
        "digest": "sha256:<digest>"
      },

      "resolvedDependencies": [{
        "uri": "git+https://github.com/...@<commit>",
        "revision": "<commit-sha>",
        "digest": {
          "sha256": "<digest>"
        }
      }]
    },

    "principal": {
      "actor": {
        "identity": "<requesting-human-agent-or-service>",
        "issuer": "<identity-provider>"
      },

      "executor": {
        "identity": "overcenter",
        "instance": "<runtime-instance>",
        "softwareRevision": "<exact-overcenter-code-revision>"
      },

      "attester": {
        "identity": "<signing-service-identity>"
      }
    },

    "authority": {
      "decision": "allow",
      "scope": ["<authorized-operation-or-resources>"],

      "policy": {
        "id": "<authority-policy-id>",
        "revision": "<exact-policy-revision>",
        "digest": "sha256:<digest>"
      },

      "claim": {
        "id": "<claim-or-lease-id>",
        "epoch": "<fencing-revision>",
        "expiresAt": "<timestamp>"
      }
    },

    "effects": [{
      "target": "<canonical-resource-uri>",
      "action": "<semantic-effect>",

      "before": {
        "revision": "<r0>",
        "digest": "sha256:<digest>"
      },

      "expectedRevision": "<r0>",
      "providerReceipt": "<provider-operation-id>",

      "after": {
        "revision": "<r1>",
        "digest": "sha256:<digest>"
      },

      "status": "committed"
    }],

    "verification": {
      "checks": [{
        "type": "exact-revision",
        "result": "pass",
        "evidence": "sha256:<digest>"
      }, {
        "type": "postcondition",
        "result": "pass",
        "evidence": "sha256:<digest>"
      }],

      "evidence": [{
        "mediaType": "<evidence-type>",
        "digest": "sha256:<digest>",
        "uri": "cas://sha256/<digest>"
      }]
    },

    "result": {
      "outcome": "committed",
      "state": {
        "revision": "<exact-result-revision>",
        "digest": "sha256:<digest>"
      },
      "checkpoint": "<monotonic-project-checkpoint>"
    }
  }
}
```

The exact field names are less important than the semantic partitions.

The attestation must distinguish:

```text
what was requested
what exact state was observed
who requested it
who executed it
what authority allowed it
what exact effects occurred
what evidence verified those effects
what exact state resulted
```

## The subject is resulting truth, not the run

The in-toto rule that subjects are immutable and digest-addressed is the right default for Overcenter.

The subject of an Overcenter transition should normally be the resulting canonical project state or resulting immutable resources, not identifiers such as:

```text
run 329
worker Fred
lease 88
project.advance invocation ABC
```

Those identify execution machinery.

The durable attestation should instead mean:

> Given exact state X and authority A, executor E caused effects D, verified them with evidence V, and produced exact state Y.

That statement remains meaningful after the worker, lease, journal, scheduler, and runtime no longer exist.

## Identity and authority must remain separate

A Sigstore-style identity answers:

> Who signed or executed this?

A TUF-style authority policy answers:

> Was that principal allowed to make this transition under the policy in force at the time?

Overcenter should retain three logically distinct principals:

```text
actor       requested the transition
executor    performed or coordinated the effects
attester    vouches for the resulting facts
```

They may sometimes be the same principal, but the schema should not assume that they are.

For example:

```text
agent or human
    requests project.advance
          |
          v
Overcenter deterministic executor
    performs fenced effects
          |
          v
receipt/attestation service
    signs resulting evidence
```

Authority should likewise be retained as exact historical evidence:

```text
policy ID
policy revision
policy digest
scope
decision
required approvals or threshold facts
claim / lease fencing generation when relevant
```

A statement such as "the actor was an admin" is insufficient. A verifier needs to know which policy and authority facts were in force for this exact transition.

## Exact revisions should appear wherever they matter

Mutable names are convenient references for humans:

```text
main
dev
latest
production
Todo
deployment/current
PR #412
```

They are poor long-term evidence.

Material references should be resolved into immutable or versioned identities whenever possible:

```text
main        -> Git commit 7b53...
PR head     -> Git commit ce91...
policy      -> revision 17 + sha256(...)
deployment  -> immutable deployment ID/revision
project     -> revision 912 + canonical digest
```

Where a provider offers native compare-and-swap revisions, retain the revision.

Where it offers immutable content, retain the digest.

Where feasible, retain both.

A useful mutation record therefore looks like:

```text
precondition:
    expected main = 7b53...

effect:
    update main 7b53... -> 912f...

verification:
    observed main = 912f...
```

This is substantially stronger than recording that an agent "merged the branch" or "updated main."

## Effects should describe semantic outcomes, not API chatter

Suppose `project.advance` internally performs:

```text
GET GitHub
GET GitHub
renew lease
POST GitHub
timeout
GET GitHub
GET GitHub
retry read
refresh token
poll check
GET GitHub
renew lease
settle
```

The durable receipt should not contain eleven semantic effects.

It should contain the externally meaningful state transition:

```text
github://repo/.../refs/heads/dev
    before: 7b53...
    operation: advance ref
    expected: 7b53...
    after: 912f...
    provider evidence: ...
    verified: true
```

This follows the same useful discipline as SLSA provenance: preserve information that materially determines or substantiates the result, not every ordinary interaction with trusted execution machinery.

Execution archaeology remains useful while recovery is possible.

It is not project truth.

## Settlement should be immutable and separately attestable

A signed Transition Attestation should never be edited later merely to change:

```text
settlement: pending
```

to:

```text
settlement: settled
```

Signed attestations should be immutable.

Instead, settlement should append another statement that refers to the original transition attestation.

Happy path:

```text
Transition Attestation T
    outcome = effects-observed
    settlement = pending
             |
             v
      verification/recovery
             |
             v
Settlement Attestation S
    subject = digest(T)
    result = settled
    all_effects_accounted_for = true
    resulting_state = Y
```

Recovery path:

```text
T1: transition
    effect may have happened
    outcome = indeterminate

R1: recovery attestation
    subject = T1
    discovered effect DID happen

C1: compensation attestation
    subject = T1
    reversed or absorbed effect

S1: settlement attestation
    subjects = T1 + R1 + C1
    all effects accounted for
    final state = X
```

This is preferable to mutating a receipt row through states such as:

```text
UNKNOWN -> RECOVERING -> SETTLED
```

because the evidentiary history remains append-only.

It also makes failure attestable. An indeterminate mutation is not evidence corruption. It is a durable claim that certainty was unavailable at that point in time.

## Long-term retention boundary

The retention test should be:

> Could an independent verifier still establish why the resulting project state was legitimate, exactly what changed, and whether every externally visible effect was accounted for?

If deleting something makes the answer no, keep it.

### Evidence that should survive long term

| Evidence | Retention |
| --- | --- |
| Signed Transition Attestation bytes | Permanent |
| Predicate/schema version | Permanent |
| Signature and verification bundle | Permanent |
| Actor, executor, and attester identities | Permanent |
| Exact pre-state revision/digest | Permanent |
| Material resolved dependencies | Permanent |
| Exact authority-policy revision/digest/scope | Permanent |
| Fencing/claim identity needed to prove authorization | Permanent |
| Semantic effects with before/after revision/digest | Permanent |
| Provider-issued mutation IDs or receipts needed to substantiate an effect | Permanent |
| Verification conclusions and evidence digests | Permanent |
| Exact resulting state revision/digest | Permanent |
| Predecessor/checkpoint attestation digest | Permanent |
| Settlement, compensation, and recovery links | Permanent |
| Historical policy body not reconstructible elsewhere | Content-addressed, policy-retained |
| External provider receipt that the provider may later discard | Content-addressed, policy-retained |
| Raw verification artifact required for future independent re-verification | Content-addressed, policy-retained |

### Execution history that can normally be garbage-collected

Once settlement is complete and required durable evidence has been extracted, these can usually be deleted:

```text
stdout/stderr
individual API reads
polling iterations
retry/backoff history
duplicate webhook deliveries
ordinary lease heartbeats
lock-contention records
caches
temporary workspaces
repeated equivalent snapshots
scheduler/process/host diagnostics
complete HTTP traces
```

There is one non-negotiable exception:

> Never garbage-collect the only remaining evidence capable of resolving an unsettled transition.

Therefore:

```text
transition SETTLED
+ durable attestation exists
+ durable evidence requirements satisfied
+ recovery horizon passed
        |
        `-> journal eligible for GC

transition INDETERMINATE / RECOVERING
        |
        `-> journal remains protected
```

Settlement is therefore not merely a business-state marker. It is a natural gate for evidence compaction.

## Evidence blobs: retain the fact, sometimes retain the bytes

Content addressing provides a useful middle ground between keeping every artifact forever and throwing away everything except a boolean result.

Suppose verification produces a 500 MB test log.

The permanent attestation need not embed 500 MB. It can instead record:

```json
{
  "type": "test-report",
  "result": "pass",
  "digest": "sha256:99af...",
  "verifier": "overcenter.verify/v4"
}
```

Whether the bytes behind `sha256:99af...` must remain permanently depends on the strength of the intended claim.

Two different verification guarantees are possible:

```text
Weak:
"Trusted verifier V evaluated evidence E and said PASS."

Strong:
"An independent party can inspect E and reproduce V's conclusion."
```

The weak claim requires the attestation, verifier identity/revision, result, and evidence digest.

The strong claim additionally requires preserving the evidence artifact itself and, depending on reproducibility requirements, the verifier implementation and relevant dependencies.

Overcenter should make this a verification-policy decision rather than solving it with blanket journal retention.

## Signatures should be portable

Sigstore's bundle concept is useful because short-lived credentials do not need to imply short-lived evidence.

A logical Overcenter receipt bundle could consist of:

```text
receipt/
|-- statement.json
|-- dsse-envelope.json
`-- verification-bundle.json
```

These do not need to be literal files, but the verifier should have equivalent durable material.

A settled transition should remain verifiable without needing:

```text
the old agent session
the old lease record
the original Hatchable process
a live GitHub Actions run
the old ephemeral signing key
```

If later verification requires recreating the original execution environment merely to determine whether the receipt is authentic, the receipt is not sufficiently self-contained.

## Attestation chaining and checkpoints

Each settled transition should reference its predecessor or canonical project checkpoint:

```text
A0
 |
 v
A1  previous = sha256(A0)
 |
 v
A2  previous = sha256(A1)
 |
 v
A3
```

This does not by itself provide all properties of a public transparency log, but it cheaply provides:

```text
ordering
gap detection
history-integrity checks
checkpointing
an anchor for later external witnessing
```

If the threat model eventually justifies stronger independent transparency, Overcenter could periodically register signed checkpoint attestations with a SCITT-style transparency service or analogous append-only witness.

The external service would prove that a particular statement was witnessed at a particular point in the append-only history. It would not become Overcenter's source of project truth.

## Execution plane versus evidence plane

The architectural distinction can be summarized as:

```text
                    EXECUTION PLANE
              disposable after settlement

       attempts  retries  polls  heartbeats
              journals  temp state
                         |
                         | distill
                         v
                EVIDENCE PLANE
               durable indefinitely

                 authority
       exact input revision/digest
              semantic effects
          verification evidence
          exact resulting state
                settlement
                 signature
```

Durable orchestration systems tend to accumulate:

```text
runs
events
attempts
leases
journals
receipts
heartbeats
recovery rows
settlement rows
provider responses
```

because deleting any one category feels dangerous.

The attestation model replaces that accidental retention policy with an explicit evidentiary rule:

> Keep whatever is necessary to prove the authoritative transition. Delete ordinary execution exhaust once it is no longer needed for recovery or independent verification.

## Relationship to Overcenter's execution model

A mature Overcenter transition should be expressible as a durable statement of this form:

> At exact state X, actor A requested transition T. Under exact authority P, executor E performed effects D against fenced revisions R. Verifiers V established postconditions Q using evidence H. The system consequently entered exact state Y. Settlement S establishes that every externally visible effect is accounted for.

Everything required to establish that sentence must survive.

Most of everything else may eventually be deleted.

This aligns with Overcenter's broader execution principle:

```text
reasoning agent
    makes judgment
        |
        v
deterministic Overcenter machinery
    executes and verifies
        |
        v
signed durable transition evidence
    establishes project truth
```

The reasoning process may be probabilistic and disposable.

Execution truth is not.

## Recommended minimal model

The immediate architectural target should not be "make receipts bigger."

It should be four small concepts:

```text
Overcenter Transition Attestation v1
           +
Overcenter Settlement Attestation v1
           +
content-addressed evidence
           +
GC eligibility derived from settlement
```

Portable signatures can then be layered onto the attestation format without changing the semantic model:

```text
Transition Attestation
        |
        v
DSSE-style signed envelope
        |
        v
portable verification bundle
```

`project.advance`, `project.define`, `project.amend`, `production.promote`, recovery, and compensation should eventually emit the same underlying evidence vocabulary even though their domain-specific predicates differ.

## Recommended invariants

A concrete Overcenter design should preserve at least these invariants:

1. A transition attestation is immutable once emitted.
2. Every attestation has an explicit versioned predicate type.
3. The attestation identifies the exact pre-state and resulting state.
4. Material mutable references are resolved to exact revisions before they become evidence.
5. Actor identity, executor identity, attester identity, and authority are modeled separately.
6. Authority is tied to an exact policy revision or digest.
7. Lease/claim fencing evidence is retained whenever it is required to prove execution authority.
8. Effects describe semantic external outcomes rather than individual provider calls.
9. Every material effect has sufficient before/after identity to support later verification or recovery.
10. Verification conclusions identify the verifier and evidence digest.
11. Settlement is an append-only attestation over prior transition/recovery evidence, never an in-place mutation of signed history.
12. No recovery-critical evidence is garbage-collected while a transition remains indeterminate.
13. Journal garbage collection is allowed only after settlement and evidence-retention policy are satisfied.
14. Settled project history remains verifiable without the original worker, lease process, runtime instance, or ephemeral credentials.
15. Attestations form a predecessor/checkpoint chain so omissions and history discontinuities are mechanically detectable.

## Design pressure for receipts

The word `receipt` should ultimately mean something stronger than "a row showing that an operation returned success."

A receipt should be:

> The durable proof that Overcenter earned the right to call a state transition true.

That definition produces a useful boundary:

```text
journal
    helps Overcenter finish or recover execution

attestation
    proves what transition occurred

settlement attestation
    proves that every material effect is accounted for
```

Once those responsibilities are cleanly separated, Overcenter can retain dramatically less operational history without weakening project truth.