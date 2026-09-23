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
