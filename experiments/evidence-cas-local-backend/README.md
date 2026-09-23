# Local evidence CAS backend

## Question

The receipt format should carry backend-neutral evidence references. What should
the local implementation use for the actual bytes?

This experiment compares:

```text
sha256(exact evidence bytes)
        |
        +--> filesystem/<digest>
        |
        +--> SQLite evidence(digest PRIMARY KEY, bytes BLOB)
```

The digest is the same in both cases. Backend identity never enters the receipt.

## Corpus

- 64 unique 256 KiB trace objects
- 16 unique 1 MiB trace objects
- every object inserted twice

The second insertion must deduplicate rather than create a second stored copy.

## Measurements

For both backends:

- first put p50/p95
- duplicate put p50/p95
- verified read p50/p95
- object count
- logical live evidence bytes
- durable close/reopen verification

Then every second object is swept.

Filesystem physical bytes are measured immediately after deletion. SQLite is
measured after DELETE + WAL checkpoint and again after VACUUM, because deleted
BLOB pages are reusable inside SQLite even when the database file has not shrunk.

There is deliberately no performance winner threshold. The architectural
question is lifecycle behavior and complexity, not a one-run microbenchmark race.

## Running

```sh
npm run test:evidence-cas-local-backend
```

## Hosted result

Evaluated at exact revision:

```text
455bcdcd0614598009bbda2644ae2c3b99f6e086
```

GitHub Actions run `35824174675`, job `107062210160`, passed.

The corpus contained 80 unique objects totaling 32 MiB and inserted each object
twice.

| operation | filesystem p50 | SQLite p50 |
| --- | ---: | ---: |
| first put | 164.797 us | 1,375.188 us |
| duplicate put | 20.739 us | 641.338 us |
| verified read | 269.773 us | 1,259.822 us |

For garbage collection:

```text
before GC
  filesystem     33,554,432 B
  SQLite         33,710,080 B

after deleting half
  filesystem     16,777,216 B
  SQLite         33,710,080 B

after SQLite VACUUM
  SQLite         16,904,192 B
```

Filesystem deletion took 1.725 ms. SQLite's batched DELETE took 28.764 ms and
VACUUM another 89.015 ms on this runner.

Both stores preserved the same SHA-256 identities and all retained evidence
survived close/reopen.

## Interpretation

Large immutable evidence bytes do not need to live in the authority database.

A smaller local architecture is:

```text
SQLite
  authority facts
  receipt refs
  evidence index / reachability if useful

filesystem CAS
  immutable evidence bytes
  named by backend-neutral SHA-256
```

This does **not** yet make the simple file writer production-worthy. Writing
directly to the final digest pathname has a crash window. The next proof must
cover atomic publication, concurrent duplicate writers, truncated preexisting
objects, and cleanup of abandoned temporary files.
