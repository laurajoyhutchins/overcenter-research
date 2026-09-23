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
