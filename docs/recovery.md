# Recovery

`RECOVERY_REQUIRED` means Overcenter knows enough to refuse ordinary replay but not enough to claim the desired state is established or absent. It is a safety state, not an error bucket.

## First rule

Do not retry a consequential effect merely because the worker died, the request timed out, or the response was lost.

The recovery question is:

    What can authoritative evidence prove about the exact reserved effect?

not:

    Did the old worker say it failed?

## Recovery decision table

| Knowledge after fresh authoritative observation | Safe action |
| --- | --- |
| desired effect is present and verifies | settle the original run under fresh current authority |
| authoritative terminal absence is established by an admitted certificate | release/reopen only through the adapter's declared replay semantics |
| trusted pre-dispatch evidence proves the request was not dispatched | release the exact reservation only if that adapter explicitly admits the evidence kind |
| evidence is stale, partial, conflicting, eventually-consistent, or otherwise indeterminate | remain recovery-bound; gather more evidence or escalate |

A successor execution generation may reconcile an older unresolved reservation. It may not overwrite that reservation with a second conflicting effect.

## Operator procedure

1. Re-read current project authority. Do not recover from a cached projection.
2. Identify the exact obligation key, run, claimed revision, execution generation history, effect contract, and unresolved reservation.
3. Reconstruct the exact provider coordinate from authoritative obligation data, not from worker-local aliases.
4. Use the provider's certified observation path. Preserve evidence identity and completeness information.
5. Let deterministic verification classify the observation.
6. Settle, release, or continue recovery only through the kernel path authorized for that evidence.
7. If deterministic machinery cannot establish a safe next action, escalate the residual ambiguity with the known facts and forbidden actions intact.

## Current narrow release exception

GitHub commit-status mutation admits one pre-dispatch release witness: a fresh HTTPS request that failed before TLS `secureConnect`, bound to the exact origin, path, method, and body digest. Post-`secureConnect` failures and HTTP errors do not prove non-dispatch and remain unresolved.

Kubernetes ConfigMap mutation currently admits no corresponding pre-dispatch release evidence. Ambiguous PATCH outcomes must reconcile through authoritative Kubernetes observation.

## What recovery must preserve

- exact revision identity;
- current execution authority;
- unresolved reservation identity;
- provider coordinate identity;
- the distinction between external truth and knowledge of external truth;
- retained evidence sufficient to justify any terminal settlement.

Recovery is a continuation of the original transaction. It is not a reset and not permission to forget the uncertain predecessor.
