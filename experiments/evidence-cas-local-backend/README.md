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
