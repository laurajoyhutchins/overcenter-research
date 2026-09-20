# Disposable-agent handoff

## Question
Can the original worker disappear completely and a fresh worker reconstruct and safely settle the same unresolved run?

## Claim and contrast
Worker-local checkout, cache, database, refs, and memory are disposable when claims, execution generations, reservations, and receipts live in authority. The control is recovery that depends on Agent A's local state.

## Hostile cases
Delete Agent A's sandbox, recover from a fresh clone, rotate execution authority, reject verifier replacement, survive lost acknowledgement, fail closed on missing authority, and race central CAS.

## Run
```sh
npm run test:handoff
gh workflow run disposable-agent-proof.yml
```

## Evidence
At `1f6ad04704b3ed594c58ad5a5759be5048c3843d`, hosted run `35463403293` passed.

## Interpretation and non-claims
Recovery identity is durable authority, not worker process state. The hosted effect-broker job invokes the same production GitHub status-effect implementation in `src/providers/github-status-effect.ts`; the experiment no longer carries a second mutation implementation. This does not prove every substrate isolates provider credentials, make GitHub's repository-scoped `statuses: write` coordinate-scoped, or guarantee liveness.
