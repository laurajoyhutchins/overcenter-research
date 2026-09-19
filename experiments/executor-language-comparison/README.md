# Go vs TypeScript executor admission experiment

This experiment asks whether Go earns a permanent production role in Overcenter's physical execution layer.

The plausible alternative is TypeScript, because Overcenter already uses TypeScript for the deterministic kernel and provider semantics. Go is admitted only if the TypeScript implementation is materially worse under the same execution contract.

## Fixed contract

Both implementations must provide:

- incremental streaming input
- bounded concurrency and backpressure
- duplicate execution-identity rejection
- exact capability and execution-spec digest validation
- completion/failure/cancellation evidence with the same authority fields
- cancellation of hanging child processes
- process-group termination so descendants do not survive executor cancellation
- no graph eligibility, lifecycle, settlement, or durable scheduler authority

The comparison is Linux-specific where process-group supervision is concerned. That matches the current hosted worker substrate and keeps the process-tree claim falsifiable.

## Admission rule

Correctness comes first. If one implementation fails a hostile case that the other passes, that is material evidence.

If both are equally correct, raw speed only counts if it is large enough to plausibly change the production architecture. Before seeing results, this experiment defines **2x** as the threshold for a material executor-only advantage in either:

- throughput for a 20,000-envelope bounded synthetic stream, or
- peak resident memory for that same stream.

Smaller performance differences are treated as noise/optimization territory and do not justify another implementation language.

Source machinery is reported but not reduced to a winner by line count. We record:

- nonblank, non-comment source lines in the language-specific runtime
- third-party runtime dependencies
- explicit mutable lifecycle bookkeeping required for subprocess cancellation

Those measurements explain maintenance cost; they do not override failed semantics.

## Hostile cases

1. Same completed frontier produces equivalent normalized evidence.
2. TypeScript independently proves its max-concurrency bound.
3. Invalid digest is rejected before a child is started.
4. Cancellation kills both the task process and a spawned grandchild.
5. Hanging work produces cancellation evidence, not fabricated success.
6. Streaming remains bounded for a large synthetic frontier.
7. The benchmark runs the already-built Go binary so compiler startup is excluded.

## Decision rule

Go earns this executor role only if the experiment shows a material advantage under the rule above that is not offset by a new correctness failure.

If TypeScript passes the same hostile cases and Go does not cross the 2x operational threshold, the evidence says to keep this role in TypeScript and delete or archive the Go implementation rather than retaining a second language on taste.
