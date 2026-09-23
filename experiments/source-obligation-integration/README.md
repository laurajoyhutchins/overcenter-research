# Source obligation integration

## Question

Can source-development work be a stable Overcenter obligation while exact Git revisions remain execution fencing, so independent work can integrate without encoding a stack of GitHub pull-request bases into the graph?

The proposed boundary is:

```text
stable source obligation
        ↓ claim
exact base SHA + obligation key
        ↓ untrusted realization
candidate commit
        ↓ trusted validation
scope + acceptance on current main
        ↓
CAS integration
        ↓
source obligation realized
```

A GitHub branch or pull request may project the candidate for review, but it is not the semantic dependency edge and is not what makes downstream work true.

## Preregistered hypothesis

Within a bounded local-Git model, a source obligation can keep one semantic identity across unrelated `main` evisions while trusted integration safely handles current-source movement by reapplying the exact candidate patch, rerunning acceptance, and using compare-and-swap on the authoritative target ref.

The hypothesis is falsified if any of the following occur:

- changing only the claim-time base changes the source obligation key;
- an unrelated `main` advance prevents a clean candidate from integrating;
- a candidate can mutate outside its declared source scope;
- a conflicting current-source change or changed acceptance context can move `main` anyway;
- a CAS race overwrites concurrent `main` work instead of retrying against the new head;
- replaying an already integrated candidate creates another integration commit.

## Treatment

`experiment.ts` uses real Git commits, worktrees, cherry-pick semantics, and atomic `git update-ref <ref> <new> <expected>` CAS. It keeps the proposed semantic intent separate from claim-time source identity:

- `SourceIntent` contains stable objective, writable paths, and acceptance checks;
- `SourceClaim` adds the exact base SHA without changing the semantic key;
- an untrusted candidate is represented by an exact commit bound to the claim key and base;
- trusted integration verifies candidate ancestry and changed paths;
- the candidate patch is applied to the current `main`, not blindly fast-forwarded from its original base;
- acceptance is rerun in that current-source candidate tree;
- only then may the target ref move by exact-head CAS;
- an integration trailer gives deterministic replay detection.

## Cases

The deterministic corpus now contains seven distinguishing cases:

1. **Stable identity.** The same semantic source intent is claimed against two different bases and must retain one obligation key.
2. **Unrelated main advance.** The candidate is produced from an older base; independent `main` work lands; trusted integration reapplies the candidate and preserves both changes.
3. **Hostile source scope.** A candidate changes one allowed and one undeclared path and must be rejected before target movement.
4. **Conflicting main advance.** Current `main` changes the same source coordinate; patch application must fail closed with re-realization required.
5. **Acceptance-context drift.** The patch applies cleantly, but a current-source invariant changed; acceptance must fail closed with re-realization required.
6. **Forged replay marker.** An unrelated current-main commit copies the candidate trailers but does not realize the candidate; trusted replay verification must reject the marker as proof and perform the real integration.\n7. **CAS race plus replay.** `main` advances after verification but before CAS; integration must retry from the new head, preserve the concurrent change, and later recognize exact replay without another commit.

## Reproduce

```sh
npm run test:source-obligation-integration
```

No network, GitHub credential, model, or database is required. The experiment needs Node.js and Git.

## Interpretation

A positive result would support the narrow source-transaction primitive needed to move orchestration out of stacked PR topology: stable graph intent, exact execution fencing, verified candidate realization, and deterministic integration into current source authority.

It would justify a production implementation target, not prove the complete GitHub workflow. The existing Codex closed-loop experiment already covers the complementary worker/publisher split for candidate patches and draft PR projection.

## Non-claims

This experiment does not prove:

- arbitrary source changes can be verified by file-content checks;
- GitHub remote-ref mutation has the same failure modes as local `git update-ref`;
- human review policy can be removed;
- merge conflicts can be resolved automatically;
- every open historical PR can be imported without an explicit mapping step;
- the current production realization fact already supports dynamic source candidates;
- successful local evidence alone authorizes production promotion before exact-head repository evidence is recorded.

## Post-review replay-provenance correction

Review found that the original treatment used the `Overcenter-Candidate` commit trailer as replay authority before independently proving that the marked commit actually realized the candidate. A concurrent or hostile source commit could therefore forge the marker and trigger `ALREADY_INTEGRATED`.

The corrected treatment makes the trailer only a lookup hint. Before replay can short-circuit, trusted code now:

1. validates candidate ancestry and declared writable scope;
2. requires both candidate and obligation-key trailers;
3. reapplies the exact candidate commit to the marked commit's single parent;
4. requires the reconstructed tree to equal the marked commit's tree;
5. reruns the intent acceptance checks; and
6. requires those acceptance checks to remain true on current `main`.

A new forged-marker negative control requires an unrelated commit carrying both exact trailers to be rejected as replay evidence and followed by a real candidate integration.

This correction is post-observation and therefore **mixed-provenance**. The original six-case exact-head result remains historical evidence, but the strengthened seven-case treatment requires fresh exact-head evaluation before the experiment can again be called supported.

## Exact-head result

Supported at exact treatment revision `83433c916eb73d636dede0c94f8dd81bc915da48` in GitHub Actions Merge gate run `35932681826`, rerun candidate job `107423153394`.

The deterministic source transaction produced the preregistered distinguishing result:

- stable source intent retained one semantic key across different claim bases;
- a stale-base candidate integrated over unrelated `main` movement while preserving both changes;
- an out-of-scope candidate was rejected with `SOURCE_SCOPE_VIOLATION` before target movement;
- a same-coordinate conflict required re-realization with `SOURCE_APPLY_CONFLICT`;
- changed acceptance context required re-realization with `SOURCE_ACCEPTANCE_FAILED`;
- an injected CAS race retried from the new head, integrated on attempt 2, preserved the concurrent change, and exact replay returned `ALREADY_INTEGRATED`.

The exact-head candidate run also passed TLA+, the production computation-boundary proof, and self-application. GitHub ultimately marked the three-minute job cancelled during final completion bookkeeping after every substantive step had completed successfully; the source experiment itself completed and emitted the result above before that cancellation.
