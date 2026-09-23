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
