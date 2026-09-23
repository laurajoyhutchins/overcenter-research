# Evidence CAS group threshold

## Question

The corpus matrix showed that universal CAS loses with no reuse and wins by the
first sampled 25% reuse point. The selective policy did better because it made
the decision per exact digest group.

This experiment zooms in on that local decision.

## Matrix

```text
trace payload target bytes
  32 64 128 256 512 1024 4096 16384

identical receipts referencing one trace
  1 2 3 4 8 16
```

For each cell:

```text
inline cost
  N complete receipt-v5 facts carrying the trace

CAS cost
  N complete reference receipts
  + one exact trace object
```

The experiment uses production receipt identities and production
`projectReceipt` semantics. Only the opaque diagnostic trace bytes vary.

## Why this matters

A global rule such as "CAS payloads above 64 KiB" is attractive because it is
simple, but the prior matrix suggests that repetition is the real source of
storage savings.

The actual decision can be even simpler:

```text
externalize(group) := cas_bytes(group) < inline_bytes(group)
```

That comparison uses facts already known when compacting or materializing the
evidence store. No statistical estimate or model judgment is required.

## Running

```sh
npm run test:evidence-cas-group-threshold
```

## Hosted result

Evaluated at exact revision:

```text
6d799ca7308dc722873f62d63f911fcd280e4613
```

GitHub Actions run `35823837095`, job `107061194775`, passed all 48 cells with
zero semantic mismatches and zero false `DONE`.

### Minimum repetition needed for CAS to use fewer canonical bytes

| trace payload | minimum copies |
| --- | ---: |
| 32 B | 3 |
| 64 B | 2 |
| 128 B | 2 |
| 256 B | 2 |
| 512 B | 2 |
| 1 KiB | 2 |
| 4 KiB | 2 |
| 16 KiB | 2 |

A singleton never won.

For duplicate pairs:

```text
  32 B   1.0047x   inline wins
  64 B   0.9976x   CAS barely wins
 128 B   0.9839x
 256 B   0.9588x
   1 KiB 0.8497x
   4 KiB 0.6793x
  16 KiB 0.5608x
```

At three copies, even the 32-byte payload crossed below flat storage at 0.9982x.

## Resulting rule

The implementation should still compare exact encoded costs because that stays
correct if schemas or digest encodings change:

```text
externalize iff
  bytes(one CAS object)
  + sum(bytes(reference receipt))
  <
  sum(bytes(inline receipt))
```

But the operational mental model is now pleasantly small:

```text
unique evidence
  -> inline is storage-cheaper

duplicate provenance-bearing evidence
  -> CAS is already cheaper for ordinary payload sizes
```

There is no evidence here for a global 64 KiB threshold or a corpus-level reuse
percentage.
