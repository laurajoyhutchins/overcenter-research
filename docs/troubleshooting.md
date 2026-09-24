# Troubleshooting

Most Overcenter errors are deliberately fail-closed. Treat the error prefix as the subsystem that refused to make an unsafe inference, not as an invitation to bypass the guard.

## Common classes

| Prefix / condition | Meaning | Safe response |
| --- | --- | --- |
| `PROJECT_INTENT_*` | declarative intent failed exact structural or semantic validation | fix the intent at source; do not patch authority facts manually |
| `STALE_REVISION` / `CLAIM_LOST` | another authority transition moved the exact state you were acting on | re-read fresh authority and let the command retry/rederive |
| `*_AUTHORITY_*` / stale execution generation | current fenced authority no longer matches | acquire only through the trusted recovery/claim path |
| `REGISTERED_EFFECT_DISPATCH_*` | effect contract is unknown, unsupported, or missing its trusted provider context | do not call provider code directly; complete/admit the provider path |
| `*_IDENTITY_*` / `*_COORDINATE_*` | provider identity or exact target does not match the obligation | stop; obtain canonical observation rather than weakening equality |
| `*_INDETERMINATE` | observation could not prove the required state | remain blocked/recovery-bound and gather stronger evidence |
| `SOURCE_*` | source task, claim, workflow evidence, or candidate binding is not exact | re-freeze/re-evaluate the exact source task; do not transplant evidence |
| `ASSIGNMENT_*` | portable worker packet or workspace violated its exact contract | discard the candidate and rerun from a fresh assignment/workspace |
| `CLAIM_ORDINAL_MISSING` / `BINDING_ORDINAL_MISSING` | replay-derived scheduling identity is incomplete | repair/reconstruct authority history; do not invent a scheduler age |

## Uncertain external effects

Timeout, connection reset, process death, and HTTP failure are not equivalent to 'the provider did not mutate'. Follow [`recovery.md`](./recovery.md). Blind retry is the most dangerous troubleshooting shortcut in the system.

## Checks to run

For a documentation-independent baseline:

    npm run typecheck
    npm run test:unit
    npm run proof:production

For adapter ambiguity:

    npm run check:adapter-diagnosability

For formal kernel and liveness models:

    npm run proof:formal

Run the narrow proof for the component you changed as well. A green broad test does not expand the documented authority boundary.

## When to escalate

Escalate when the remaining question is genuinely not mechanically decidable from admitted evidence. Carry forward:

- exact obligation/run/revision identities;
- current authority head and execution generation;
- the unresolved effect coordinate;
- observations already attempted and why they were insufficient;
- actions that remain forbidden, especially replay.

An escalation should shrink ambiguity, not erase it.
