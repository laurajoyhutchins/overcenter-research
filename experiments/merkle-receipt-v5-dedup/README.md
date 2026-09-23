# Merkle receipt-v5 deduplication

## Question

The first Merkle receipt experiment preserved the intended safety semantics but a
single naive eight-object proof used 1.898x the bytes of its flat equivalent.
Does that penalty survive when the representation is connected to actual
production receipt-v5 facts and shared evidence is stored once?

This follow-on is separately preregistered. It does not alter the evaluated
criteria or result of `merkle-execution-receipts`.

## Production-backed corpus

The experiment generates 128 successful GitHub commit-status executions through:

```text
OvercenterKernel
      |
      v
claim exact work
      |
      v
performGithubCommitStatusEffect
      |
      v
production effect reservation
      |
      v
deterministic GitHub provider double
      |
      v
production certified readback
      |
      v
overcenter-git-receipt-v5
```

Each execution has its own run, authority coordinates, and SQLite store. The
obligation definition and certified observation bytes are deliberately identical
so a content-addressed representation has something legitimate to share.

## Sidecar factoring

The treatment stores four object classes:

```text
definition   shared when exact immutable definition bytes match
observation  shared when exact certified observation bytes match
execution    receipt-v5 run / authority identity
settlement   receipt kind + diagnostic + settled_at + parent hashes
```

The settlement root names all information required to reconstruct the exact
receipt-v5 fact and the obligation needed by production `projectReceipt`.

This is deliberately a receipt-v5 decomposition, not a new settlement policy.

## Preregistered falsification

The experiment fails if any of these occur:

1. any generated receipt is not a production receipt-v5 DONE;
2. any reconstructed receipt-v5 fact differs canonically from the original;
3. production `projectReceipt` disagrees between original and reconstructed facts;
4. the complete 128-receipt Merkle corpus, including root-index bytes, remains
   larger than the fair flat baseline of one shared obligation definition plus
   all 128 flat receipt-v5 facts;
5. cross-run execution substitution creates a false DONE.

Ratios are also reported at 1, 8, 32, 64, and 128 receipts. The first measured
ratio at or below 1.0 is the crossover.

## Non-claims

The corpus intentionally maximizes a real deduplication opportunity. It does not
claim every workload repeats observations, that observations at different times
are interchangeable, or that canonical byte counts equal SQLite/object-store
physical storage costs.

## Running

```sh
npm run test:merkle-receipt-v5-dedup
```

## First hosted run: negative control found a missing authority edge

Run `35821293168`, job `107053492723`, at exact revision
`540bc0398efe36fd32d38631836f85535a9f9ff0` reached the cross-run substitution
control and failed because a newly constructed root that referenced another valid
execution object was still internally hash-consistent.

That is not a digest failure. It is an authority failure:

```text
content-addressed objects
        |
        | prove integrity
        v
internally valid forged root
        |
        | still needs authority
        v
existing settlement_commit -> accepted root
```

The correction does not duplicate run identity into the settlement payload. It
requires the candidate root to be the root authorized by the existing
`settlement_commit`. A swapped parent changes the root and therefore fails the
authority binding even when every referenced object is individually valid.

The preregistered semantic-parity and <=1.0x-at-128 storage criteria are
unchanged. Because the treatment was corrected after the first run, registry
design provenance is now recorded as `mixed`.

## Authority-bound hosted result

The corrected treatment was evaluated at exact revision:

```text
56378d1250b28441a246f3058b7e0fe5c5bd8eab
```

GitHub Actions run `35821692372`, job `107054704870`, passed.

```text
actual receipt-v5 facts             128
semantic mismatches                   0
false DONE                            0
unique Merkle objects               259
shared definitions                    1
shared observations                   1

Merkle / flat bytes
  1 receipt                       1.316x
  8 receipts                      0.615x   <- first measured crossover
 32 receipts                      0.528x
 64 receipts                      0.514x
128 receipts                      0.506x

encode p50                     125.525 us
reconstruct + project p50      151.954 us
```

The result changes the interpretation of the first experiment's 1.898x
single-receipt overhead. The naive single-proof representation is expensive, but
the receipt-v5-shaped content-addressed corpus amortizes quickly when immutable
definition and certified observation bytes repeat.

The more important finding is the failed predecessor run. A Merkle DAG proves
that a root is internally consistent; it does not prove that the root is the
one Overcenter authorized. The corrected treatment therefore preserves the
existing boundary:

```text
Merkle closure      -> integrity + exact reconstruction + deduplication
settlement_commit   -> authority for which root is accepted
fresh observation   -> current admissibility for mutable external reality
```

Those are distinct responsibilities and should remain distinct.
