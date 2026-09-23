# Evidence reference publication

## Question

Can Overcenter safely split immutable evidence bytes from authoritative metadata
without a distributed transaction between the filesystem CAS and SQLite?

## Protocol

```text
evidence bytes
    |
    v
FileEvidenceStore.put
  write + fsync + atomic publish + directory fsync
    |
    | returns only after evidence is durable
    v
authority.append(expectedHead, evidence ref)
    |
    v
authoritative reference
```

The order is intentional. A crash between the two writes can create an
unreferenced evidence object, but must never create an authoritative reference
to evidence that was not durably published first.

## Hostile cases

1. Kill the writer after evidence publication but before authority append.
   Authority must remain unchanged; the evidence object is an orphan and may be
   collected.
2. Kill the writer immediately after authority append returns. The reopened
   authority history must validate and its referenced evidence must verify.
3. Launch two writers from the same expected authority head with different
   evidence. Exact CAS permits one authority winner; evidence from the loser is
   merely an orphan.
4. Delete referenced evidence after settlement. Resolution must fail closed with
   missing evidence rather than silently accepting the reference.
5. Attempt to publish an already-corrupt digest target. The evidence store must
   reject it before the authority write can occur.

Garbage collection is derived from authoritative references. It is not part of
the evidence store API because the byte store cannot know which objects are
authoritative on its own.

## Expected architectural consequence

If this passes, no cross-store transaction is required:

```text
evidence first  -> crash => harmless orphan
authority second -> crash => durable reference to already durable bytes
```

The remaining migration question is schema compatibility: how receipt-v5 can
move from inline observation bytes to an evidence reference without breaking
historical replay.

## Running

```sh
npm run test:evidence-reference-publication
```

The experiment criteria above were committed before the first hosted execution.
