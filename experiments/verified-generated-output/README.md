# Verified generated output

## Question

Can Overcenter represent a generated artifact whose exact bytes are not known when the obligation is defined, while keeping the worker non-authoritative and giving downstream obligations a stable semantic identity?

The proposed boundary is:

```text
semantic proposal obligation
        |
        | exact claim + source binding
        v
untrusted generated artifact bytes
        |
        | trusted validation derives scope from bytes
        v
durable EvidenceStore publication
        |
        | exact EvidenceRef
        v
verified-output receipt by authority CAS
        |
        | settlement receipt identity
        v
downstream semantic dependency
```

The worker never supplies the authoritative artifact digest. Trusted software derives it from the exact retained bytes.

## Preregistered hypothesis

Within a bounded deterministic model, a generated source proposal can become a verified output without a predeclared content postcondition if and only if trusted software:

1. checks exact assignment, run, claimed authority revision, and source revision;
2. derives changed source paths from the artifact bytes and enforces the declared writable scope;
3. durably publishes the exact bytes to the existing content-addressed evidence store before authority references them;
4. commits a verified-output receipt by exact-head compare-and-swap; and
5. makes downstream semantic identity depend on that authoritative settlement receipt, not on worker-declared output identity.

The hypothesis is falsified if any hostile case below can create authoritative output identity or downstream identity without those conditions.

## Treatment

`experiment.ts` uses the production `FileEvidenceStore` and an experimental one-coordinate authority CAS. The artifact itself is a canonical JSON source proposal containing file replacements. The trusted validator parses the retained bytes and derives the changed paths; the candidate envelope contains no artifact digest and no worker-declared changed-path list.

The experimental receipt is intentionally not a production receipt schema. It tests whether the semantic primitive is coherent before changing kernel settlement.

## Distinguishing cases

1. **Ordinary generated output.** Unknown-at-definition artifact bytes are validated, published, authority-referenced, read back by digest, and given downstream identity through the settlement receipt.
2. **Output sensitivity.** Two different valid artifacts under otherwise identical claim metadata produce different evidence references, settlements, and downstream identities.
3. **Forged claim binding.** Wrong assignment digest, run, claimed revision, or source revision is rejected before evidence publication or authority movement.
4. **Hostile source scope.** An artifact that writes outside declared paths is rejected based on paths derived from the artifact bytes.
5. **Evidence-first crash window.** Publication without authority append leaves an orphan object but no authoritative output.
6. **Writer race.** Two valid outputs published from one expected authority head may both create immutable evidence objects, but exactly one authority CAS wins and only that winner determines downstream identity.
7. **Referenced evidence corruption.** If bytes at an authoritative EvidenceRef are missing or corrupt, downstream consumption fails closed.
8. **Unsafe self-declared identity control.** A deliberately unsafe scheme that trusts a worker-declared digest permits two distinct artifacts to collide semantically and must be killed by the treatment.
9. **Unsafe authority-first control.** A deliberately unsafe authority-first ordering can create a dangling authoritative reference and must be killed by the treatment.

## Reproduce

```sh
npm run test:verified-generated-output
```

No network, provider credential, database, model, or GitHub mutation is required.

## Interpretation

A positive result would support a narrow new kernel concept: a trusted **verified generated output** receipt whose output identity is established after execution from retained evidence rather than predeclared in the postcondition.

It would also support lowering source development into at least two semantic obligations:

```text
source proposal
   reasoning
      |
      v
verified generated output
      |
      | settlement-receipt dependency
      v
source integration
   deterministic verification + effect
```

That is materially different from marking a source-change obligation DONE because an agent returned a commit.

## Non-claims

This experiment does not prove:

- arbitrary source proposals are semantically correct;
- source integration or Git ref mutation is safe;
- generated output should replace fixed postconditions for ordinary provider effects;
- the local file evidence backend is a distributed artifact service;
- garbage collection is safe while publishers are in flight;
- a settlement receipt alone is sufficient if referenced evidence is unavailable;
- a reasoning worker may choose its own claim, source revision, writable scope, verifier, or settlement identity;
- source proposal and source integration should necessarily be exposed as two user-visible graph nodes.
