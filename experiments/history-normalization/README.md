# Semantic history normalization

## Question

Can Overcenter derive a canonical causal execution history in which certified-independent interleavings and a narrowly proven `NOT_DISPATCHED` release sequence normalize to the same semantic form without mutating or discarding the authoritative fact history?

The experiment treats normalization as a **derived projection**:

```text
immutable fact history
        |
        v
validated production replay
        |
        +--> semantic replay signature
        |
        v
typed semantic events
        |
        | certified independence + rewrite rules
        v
canonical semantic normal form
```

The raw SQLite fact log remains authoritative and unchanged.

## Preregistered treatment

The bounded corpus has two independent obligations:

- `a-status`: the admitted GitHub commit-status effect;
- `b-work`: an unrelated file-content obligation.

The GitHub status attempt is forced through the production fresh-HTTPS path to fail before `secureConnect`. Production machinery must therefore reserve the effect, retain the trusted `NOT_DISPATCHED` witness, release the reservation, and project the obligation back to `READY`.

Two legal histories are generated:

```text
status-first                    work-first

claim A                         claim B
reserve A                       claim A
release A                       reserve A
READY receipt A                 release A
claim B                         READY receipt A
```

The normalizer is allowed only two positive laws in this treatment:

1. adjacent events from the explicitly certified-independent pair `a-status` / `b-work` may commute toward canonical obligation order;
2. one exact `reserve -> trusted release -> effect-not-dispatched receipt` triple may collapse to one structured `aborted-attempt` event that retains the attempt ordinal, generation, witness kind/source, and receipt kind.

Opaque run IDs, commit IDs, reservation IDs, and evidence digests remain provenance, not semantic identity.

## Bounded contextual check

The two interleavings must have identical production-derived semantic replay signatures and identical normal forms under four continuations:

- no continuation;
- defer the independent work obligation;
- retry the released status obligation as a new run;
- defer the work obligation and retry the released status obligation.

This is a bounded contextual-equivalence check. It does not establish equivalence under arbitrary future continuations.

## Critical-pair check

The work-first history exposes an overlap between:

- commuting an independent claim across the status-attempt events; and
- collapsing the status reservation/release/receipt triple.

Every available first rewrite from that overlap must reduce to the same normal form. The checker is deliberately finite and local; it is not a general Knuth-Bendix completion procedure.

## Negative controls

The experiment must reject four attractive but unsafe laws:

1. **Conflicting effects commute.** Production admission must reject two unordered GitHub status obligations targeting the same canonical coordinate with different desired states.
2. **Equal-valued observations deduplicate.** Two structurally valid absence-evidence envelopes with the same subject but different snapshot/provenance identity must retain distinct digests.
3. **A proven-not-dispatched attempt is a no-op.** A released attempt and a never-attempted history may both project the status obligation `READY`, but their production replay signatures must differ because the released run/receipt remains semantically observable.
4. **Create followed by delete is universally a no-op.** Final provider visibility may match an empty history while retained provider/audit events remain distinguishable.

A negative control that fails to produce its distinguishing witness falsifies the treatment.

## Success criteria

The bounded hypothesis is supported only if:

- all four continuation pairs agree under production replay after opaque physical identities are alpha-normalized;
- both histories reduce to byte-identical semantic normal forms and semantic digests;
- the raw provenance digests remain distinct;
- the critical-pair overlap is joinable;
- all four negative controls are detected;
- no production source file is changed.

## Run

```sh
npm run test:history-normalization
```

A focused GitHub Actions workflow executes the treatment on pull requests that touch this experiment.

## Interpretation boundary

A positive result would support a new research direction:

```text
raw durable history
    !=
canonical semantic history
```

Canonicalization could become a reproducible projection with a semantic digest plus a separate provenance binding. It would not justify rewriting or garbage-collecting authoritative facts, nor would it prove that arbitrary provider histories admit a finite terminating confluent rewrite system.

## Non-claims

- The experiment does not implement general Knuth-Bendix completion.
- It does not prove global confluence or termination for arbitrary Overcenter histories.
- It does not infer independence automatically for arbitrary obligations.
- It does not make equal provider values equivalent across snapshots.
- It does not erase `NOT_DISPATCHED` attempts from audit or provenance history.
- It does not prove create/delete cancellation safe for real providers.
- It does not change production replay, settlement, receipts, or authority.


## Result

Supported at exact preregistered treatment revision `ee77259a8db92c11f2c41de6a4cf40007d87778a` in GitHub Actions run `35948438715`.

Observed treatment:

```text
interleaving executions:       8
bounded continuations:         4
critical-pair branches:        4, all join
raw events, base case:         5 per history
semantic normal-form events:   3
provenance digests:            distinct
semantic normal forms:         identical within each continuation
```

The four continuation-specific semantic digests were:

```text
none              b2823ff7031a1bf8ee3ea26f809d5e14869336fa25b9f407ff2f7afc96d1e3eb
defer-work        712e254fd9a9f1bed6f647efcc8748064f781dc01bd92cb6c05b85260e21616a
retry-status      3ba1ccf459a2dd606d0663d16379fe5f5c9f0bb09a21de5a589609b54ecd9fd9
defer-and-retry   cb7bf23995dceab519e8635f9d61fe63c6c27346e21fe76e507efa4ed5bc656f
```

All hostile controls were distinguished:

- incompatible unordered status effects were rejected by production admission;
- snapshot-distinct absence evidence retained distinct digests;
- a released `NOT_DISPATCHED` attempt differed from a never-attempted history despite both exposing `READY`;
- create/delete retained audit distinction despite matching empty final visibility.

### Interpretation

Within this bounded corpus, a semantic normal form can quotient away one real independent interleaving and compress one proven aborted effect sequence without conflating physical provenance. The result supports keeping two identities:

```text
semantic digest   = digest(canonical semantic normal form)
provenance digest = digest(raw authoritative fact history)
```

This is evidence for a derived canonical-causal receipt layer, not evidence for rewriting the authority log. General completion, automatically derived independence, and arbitrary provider cancellation remain open.
