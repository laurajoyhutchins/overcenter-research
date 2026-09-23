# Evidence CAS atomic publication

## Problem

A file named by its digest must never mean "probably these bytes."

Directly writing to the final digest pathname has an ugly crash state:

```text
open sha256:abc...
write first half
CRASH
----------------
digest pathname exists
bytes are incomplete
```

A later writer that treats `EEXIST` as successful deduplication would preserve
the corruption.

## Treatment

```text
compute digest(bytes)
        |
        v
write unique temp in target directory
        |
      fsync
        |
        v
hard-link(temp, digest-path)   <- atomic no-replace publish
        |
   fsync directory
        |
        v
unlink temp
```

If another writer wins the link race, the loser verifies the existing target
before accepting it as a duplicate.

Hard-link publication matters because a plain rename can replace an existing
object. For a CAS, two different byte strings must never silently contend for one
digest pathname.

## Hostile cases

1. SIGKILL immediately after temp fsync.
2. SIGKILL after link + directory fsync, before temp unlink.
3. Eight concurrent writers of identical bytes.
4. A deliberately truncated object already occupying the correct digest path.
5. A normal duplicate write.
6. Stale temp sweep after the crash cases.
7. Close/reopen and verified read.

The sweep is explicit in the experiment. A real long-running service should only
delete temps old enough that no live publisher could still own them.

## Running

```sh
npm run test:evidence-cas-atomic-publish
```

## Hosted result

Evaluated at exact revision:

```text
3b9758dfd4e01e26c0e3e7504e31ce747cc6a0db
```

GitHub Actions run `35824626596`, job `107063576774`, passed every hostile
case.

```text
crash after temp fsync
  final object        absent
  temp object         complete + sweepable

crash after link + directory fsync
  final object        complete + digest-valid
  temp object         complete + sweepable

concurrent writers    8
final objects         1
corrupt target        rejected
false accepts         0
```

For 256 KiB evidence:

```text
hardened first put p50      1,157.760 us
hardened first put p95      2,112.502 us
duplicate put p50             471.165 us
verified read p50             436.420 us
```

The file and directory fsyncs account for much of the write-cost increase versus
the earlier naive filesystem measurement. That is the correct trade: publication
latency buys a final-path invariant that is mechanically checkable after a
process dies.

## Promotion boundary

This is enough evidence to promote the **storage primitive**, not the receipt
migration.

The next production-shaped step is:

```text
EvidenceRef
  sha256
  byte_length

EvidenceStore
  put(bytes) -> EvidenceRef
  get(ref) -> verified bytes

FileEvidenceStore
  atomic local implementation
```

Receipt-v5 remains unchanged until a separate migration proves that referenced
evidence can be introduced without creating a split authority or unrecoverable
missing-object state.
