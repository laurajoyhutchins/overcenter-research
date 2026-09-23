# Evidence CAS break-even

## Question

The evidence-leaf experiment established that content-addressed evidence can be
much smaller when the same certified bytes recur. That corpus deliberately had
100% reuse.

This experiment asks where the advantage disappears.

## Matrix

The corpus size is fixed at 128 receipt-v5 identities.

```text
payload sizes
  1 KiB
 16 KiB
256 KiB
  1 MiB

reuse
  0%
 25%
 50%
 75%
100%
```

A reuse fraction controls the number of distinct trace byte strings. Zero reuse
means 128 distinct traces. Full reuse means one trace shared by all 128 receipts.

The trace is stored in the receipt's schema-valid `diagnostic.execution_trace`
field. Receipt identity comes from actual production kernel executions; trace
payloads are deterministic experiment data because the current production worker
boundary does not yet emit record/replay traces.

## Three storage policies

```text
flat
  trace bytes inline in every receipt

universal CAS
  every trace externalized
  receipt carries digest ref

exact-cost selective
  group identical trace digests
  externalize a group iff:
    referenced representation + one object < inline representation
```

The third policy is intentionally boring deterministic software. It does not
guess a global threshold. It computes whether a particular exact-byte evidence
group is cheaper to externalize.

## Falsification

The experiment fails if receipt reconstruction changes settlement semantics, if
universal CAS somehow appears to save bytes for zero-reuse evidence, if full
reuse fails to produce savings, or if the exact-cost policy ever exceeds flat
canonical bytes in the matrix.

A 256 KiB / 50%-reuse case also exercises a real temporary-directory CAS:

- write objects by SHA-256;
- read and verify hashes;
- measure p50/p95 lookup;
- inject orphan objects;
- mark from authoritative references;
- sweep;
- verify every live object remains and every orphan disappears.

Cold and warm recovery byte counts are reported separately.

## Running

```sh
npm run test:evidence-cas-break-even
```

## Hosted result

Evaluated at exact revision:

```text
9bf7dc83d36700c022dcbf1af2a77ff873809cb2
```

GitHub Actions run `35823476017`, job `107060113122`, passed the full
preregistered matrix with zero semantic mismatches and zero false `DONE`.

### Universal CAS / flat byte ratio

| trace size | 0% reuse | 25% | 50% | 75% | 100% |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 KiB | 1.0167x | 0.9332x | 0.8498x | 0.7663x | 0.6855x |
| 16 KiB | 1.0029x | 0.7819x | 0.5608x | 0.3398x | 0.1256x |
| 256 KiB | 1.0002x | 0.7522x | 0.5043x | 0.2563x | 0.0161x |
| 1 MiB | 1.0001x | 0.7506x | 0.5011x | 0.2516x | 0.0099x |

The first sampled universal-CAS crossover was 25% reuse for every payload size.

The exact-cost selective policy behaved differently. At 0% reuse it externalized
nothing and was exactly 1.0x flat storage. At 25% reuse it externalized only the
32 repeated digest groups and left the singleton groups inline. It never exceeded
flat bytes in any cell.

The implication is that payload size determines the magnitude of savings, but
**exact-byte repetition determines whether storage deduplication exists at all**.

### File-backed representative case

For 256 KiB traces at 50% reuse:

```text
unique evidence objects             64
verified lookup p50           2429.117 us
verified lookup p95           5060.002 us

flat recovery bytes             33,837,074
cold CAS recovery bytes         17,063,250
warm CAS recovery bytes            282,514

injected orphan objects                 16
orphans deleted                         16
live objects deleted                     0
GC reclaimed bytes               4,195,184
GC sweep                           718.197 us
```

The warm-recovery number is particularly useful for record/replay: after a worker
or recovery node already has the content-addressed trace objects, the authority
history need only move compact references.

## Architectural implication

Do not encode a fixed global rule such as "all evidence above 64 KiB goes to CAS."

Use deterministic economics:

```text
for each exact evidence digest group:

  inline_cost =
      sum(receipts carrying evidence inline)

  cas_cost =
      one evidence object
      + sum(receipt references)

  externalize iff cas_cost < inline_cost
```

That rule naturally keeps unique evidence inline and externalizes repeated
evidence. It adapts to payload size and reference overhead without policy tuning.

Large unique traces may still be externalized for independent operational
reasons such as portable recovery, streaming, retention tiers, or avoiding large
authority rows. Those should be explicit reasons, not mislabeled as
deduplication savings.
