# Git as a Transaction Substrate

## Question

What lower-level transactional and concurrency guarantees does Git already provide that Overcenter should rely on rather than reimplement? Where does Git stop being sufficient, leaving real work for Overcenter's lease, evidence, settlement, and recovery layers?

The central conclusion is:

> Git already provides a strong repository-local transaction substrate: immutable candidate objects, exact snapshot identity, optimistic concurrency through expected-old object IDs, atomic ref transactions, ancestry, and remote atomic push. Overcenter should treat those primitives as the authoritative repository commit boundary rather than rebuilding weaker equivalents above them.

The useful model is:

```text
immutable Git objects
        |
        | prepare candidate state
        v
 blob -> tree -> commit C(parent=A)
        |
        | no authoritative branch state changed yet
        v
CAS(ref, expected_old=A, new=C)
        |
        +-- mismatch -> deterministic stale-authority failure
        |
        `-- success  -> repository transition committed
                         |
                         v
                 ancestry / receipt / recovery
```

The most important architectural distinction is between **preparing immutable Git objects** and **changing a ref that makes one of those objects authoritative**.

## Executive recommendation

For repository-local transitions, make the ref compare-and-swap the linearization point.

Conceptually:

```text
prepare:
    create blobs
    create tree
    create commit C(parent=A)

commit:
    compare-and-swap refs/heads/<branch>
        expected old OID = A
        new OID          = C
```

Do not rely on:

```text
read ref
compare in Overcenter
later write ref
```

because the comparison and mutation are separate operations.

Git's native model is:

```text
update ref to C if and only if it still equals A
```

GitHub now exposes the same shape through GraphQL `updateRefs`, including `beforeOid`, `afterOid`, and atomic multi-ref updates. That is a much closer fit to Overcenter's exact-revision model than the REST "update a ref" endpoint, which accepts the new SHA and a force flag but no expected-old SHA.

## 1. `git update-ref` is compare-and-swap

At Git plumbing level, the critical primitive is:

```bash
git update-ref <ref> <new-oid> <old-oid>
```

The old OID is not documentary metadata. Git verifies that the ref still contains that exact object before changing it.

Conceptually:

```text
CAS(ref, observed, desired)

current == observed
    -> ref := desired
    -> success

current != observed
    -> no mutation
    -> conflict
```

A zero old OID can assert that a ref must not already exist. This gives branch creation the same conditional-write shape:

```text
CAS(new_branch, ZERO, C)
```

References:

- Git `update-ref`: https://git-scm.com/docs/git-update-ref
- Git internals, refs: https://git-scm.com/book/en/v2/Git-Internals-Git-References

### Why this matters for Overcenter

An Overcenter-style `expected_head` check is only fully authoritative when it participates in the mutation itself.

This:

```text
READ head -> A
CHECK A == expected
...
WRITE head -> C
```

contains a time-of-check/time-of-use window.

This:

```text
CAS(head, A, C)
```

does not have that particular race because the expected-old comparison and write are one ref operation.

The first pattern is useful as an early rejection optimization. The second pattern is the correctness boundary.

## 2. Expected-old OIDs are part of Git's network mutation protocol

This is not merely a convenience offered by a local command.

The receive-pack protocol used by Git push represents a ref update in terms of both the old and new object IDs:

```text
old-id new-id ref-name
```

That means the client's observation of remote authority travels with the requested mutation. A remote ref that changed since discovery can cause the push to fail.

Reference:

- Git pack protocol / receive-pack commands: https://git-scm.com/docs/gitprotocol-pack

The design principle is directly applicable to Overcenter:

> The observed authority revision belongs in the authoritative mutation request, not merely in an earlier validation step.

In Git, the expected old OID simultaneously acts as:

- exact version;
- optimistic concurrency token;
- stale-state detector;
- authority coordinate;
- evidence of what repository state the writer claims to have observed.

That is remarkably close to Overcenter's existing exact-revision vocabulary.

## 3. `--force-with-lease` is user-facing CAS

`git push --force-with-lease=<ref>:<expect>` allows a push only when the remote ref still equals an expected value.

Despite the word "lease," this is not a temporal distributed lease. It is an optimistic concurrency guard on repository authority.

Reference:

- Git push: https://git-scm.com/docs/git-push

The naming is nevertheless useful prior art because it highlights two different concepts that Overcenter should keep separate:

```text
Overcenter temporal lease
    "Is this still the authorized worker/generation?"

Git expected-old OID
    "Is this still the exact repository state that worker observed?"
```

Both checks may be necessary. Neither substitutes for the other.

## 4. Git ref transactions already provide a transaction protocol

`git update-ref --stdin` supports grouped ref updates and explicit transaction commands including:

```text
start
prepare
commit
abort
```

During preparation Git attempts to lock affected refs and verify their expected values. If the transaction cannot be prepared consistently, it does not proceed to commit.

Reference:

- Git `update-ref`: https://git-scm.com/docs/git-update-ref

The correspondence with Overcenter is useful:

| Git | Overcenter analogue |
| --- | --- |
| start | begin bounded operation |
| verify old OIDs | verify exact authority |
| prepare | prepare candidate transition |
| lock refs | prevent conflicting authority changes |
| commit | publish authoritative state |
| abort | fail closed |

One nuance matters: Git's ref transaction mechanism is a write transaction over refs, not a general serializable database snapshot. Git documents that individual ref changes are atomic but concurrent readers can observe subsets while a multi-ref transaction is being applied.

That does not diminish its usefulness as a repository-local authoritative write primitive. It simply defines the boundary correctly.

## 5. Atomic push is the remote form of grouped ref settlement

Git servers can advertise the `atomic` push capability. With an atomic push, either all requested ref updates succeed or none do.

References:

- Git protocol capabilities: https://git-scm.com/docs/gitprotocol-capabilities
- Git push: https://git-scm.com/docs/git-push

This matters if an Overcenter repository transition logically requires more than one ref to move together.

Instead of:

```text
update ref A
update ref B
repair if B fails
```

Git can provide:

```text
atomic {
    CAS(ref A, A0, A1)
    CAS(ref B, B0, B1)
}
```

For repo-local coordination state, this can eliminate an entire class of partial-write recovery.

It does not make cross-provider operations atomic. GitHub, Linear, CI systems, deployment platforms, and databases still form a distributed transaction problem when combined.

## 6. GitHub's APIs expose different strengths

The distinction between GitHub's REST and GraphQL ref mutation surfaces is important.

### REST update-a-reference

GitHub's REST ref update endpoint accepts the desired new SHA and a `force` boolean.

With `force:false`, GitHub rejects non-fast-forward updates. That is a valuable invariant, but it is not identical to:

```text
current ref must equal exactly A
```

A ref can advance from A to B while C remains a fast-forward from B. A fast-forward check protects ancestry, not equality with the exact state the caller inspected.

Reference:

- GitHub REST Git references: https://docs.github.com/en/rest/git/refs

### GraphQL `updateRefs`

GitHub's GraphQL Git ref mutation exposes the stronger shape Overcenter wants. A ref update specifies values including:

```text
name
beforeOid
afterOid
force
```

`beforeOid` is the expected current value. GitHub applies the ref updates as an atomic transaction.

Reference:

- GitHub GraphQL Git mutations / `updateRefs`: https://docs.github.com/en/graphql/reference/mutations#updaterefs
- GitHub GraphQL Git input objects: https://docs.github.com/en/graphql/reference/input-objects

For a normal branch advancement:

```text
beforeOid = A
afterOid  = C
```

For branch creation:

```text
beforeOid = 0000000000000000000000000000000000000000
afterOid  = C
```

For several coordinated refs:

```text
updateRefs([
    ref1: A0 -> A1,
    ref2: B0 -> B1
])
```

This is much closer to Git's native ref transaction semantics than a read/check/REST-PATCH sequence.

## 7. Object immutability separates preparation from authoritative mutation

Git is a content-addressed object database.

Blobs, trees, and commits are identified by object IDs derived from their contents. Git does not overwrite an existing commit with different contents under the same identity. New content produces another object.

Reference:

- Git internals, Git objects: https://git-scm.com/book/en/v2/Git-Internals-Git-Objects

Consider:

```text
branch -> A

create blob B1
create tree T1
create commit C1(parent=A)

branch -> A
```

Repository object storage changed, but the authoritative branch did not.

This is a crucial recovery distinction.

A process that crashes after constructing `C1` but before updating the branch has prepared a candidate. It has not partially committed the branch transition.

The unreachable candidate may remain temporarily in object storage and may eventually be garbage collected if nothing references it.

### Better mutation-certainty model

For Git-backed transitions, Overcenter should distinguish at least:

```text
candidate preparation:
    not_started
    candidate_prepared
    candidate_oid_known
    candidate_outcome_unknown

authority transition:
    ref_not_attempted
    ref_commit_attempted
    ref_commit_rejected
    ref_commit_confirmed
    ref_commit_outcome_unknown
```

Only the second family should drive "may have changed authoritative repository state" recovery.

There can still be uncertainty about candidate-object creation itself. For example, an API request can succeed while its response is lost. Commit retries can also produce another OID if author/committer metadata differs. But that is a different class of ambiguity from uncertainty about whether the authoritative ref moved.

## 8. Commit ancestry is a durable causal graph

A Git commit records its parent OID or OIDs. Reachability through those parents gives Git a mechanically inspectable causal history.

Reference:

- Git revisions: https://git-scm.com/docs/gitrevisions

For:

```text
A -> B -> C -> D
```

Git can establish:

- the exact predecessor of D;
- whether A is an ancestor of D;
- whether two histories diverged;
- the exact tree associated with any commit;
- whether a proposed ref move preserves ancestry.

A divergence is represented structurally:

```text
      B1
     /
A --
     \
      B2
```

This is stronger than treating commit SHAs as opaque version labels.

### Implication for Overcenter

When Git is the authoritative source, use the Git commit OID directly for exact repository identity.

Do not create another hash merely to answer:

> Is this exactly the same repository revision?

Semantic fingerprints can still be valuable when they answer a different question, for example:

> Did the domain-relevant graph definition or transition dependency set change?

The two layers should therefore remain distinct:

```text
Git OID
    exact repository snapshot identity

semantic fingerprint
    domain-relevant equivalence or compatibility
```

## 9. Reflogs are prior art for transaction receipts

Git reflogs record changes to ref tips and allow local recovery of previous ref positions.

Reference:

- Git reflog: https://git-scm.com/docs/git-reflog

Conceptually, a reflog is close to an append-only sequence of:

```text
old authority
new authority
who/when/why
```

That makes reflogs useful prior art for Overcenter's mutation receipts and recovery history.

However, GitHub does not expose a general public server-side reflog API equivalent to local Git's reflog commands. Overcenter therefore cannot simply delegate its entire receipt system to GitHub reflogs.

A repo-local receipt ref could still be useful for transitions whose evidence should travel with the repository:

```text
refs/overcenter/transactions/<subject>

R1 -> R2 -> R3
```

Each receipt commit could contain information such as:

```text
authority_before: A
authority_after: B
operation: project.amend
run_ref: ...
evidence: ...
```

Advancing that receipt ref can itself be guarded by expected-old OID semantics, and, when appropriate, updated atomically with the authoritative ref.

This should be considered an optional repo-local evidence mechanism, not a replacement for Overcenter's cross-system journal.

## 10. Git does not replace temporal fencing

Git can reject a stale repository revision. It cannot by itself determine whether the caller is still the authorized execution generation in an external lease system.

Consider:

```text
Git HEAD = H

worker A acquires authority epoch 41
worker A stalls
lease expires
worker B acquires authority epoch 42
Git HEAD remains H

worker A resumes:
    expected Git HEAD = H    current
    authority epoch = 41     stale
```

A Git CAS using `H` cannot distinguish A from B if both are otherwise capable of sending the update.

Therefore the correct composition is:

```text
may_commit =
    current_execution_generation
    AND
    git_ref == expected_old_oid
```

The temporal lease/fence answers:

> Is this still the authorized worker/generation?

The Git CAS answers:

> Is this still the exact repository state that generation observed?

This complements the separate distributed-fencing research in `research/distributed-fencing.md`.

## 11. Where current Overcenter behavior duplicates weaker Git guarantees

The current Overcenter GitHub changeset design inspected during this research contains the right concepts but implements several of them above Git at weaker boundaries.

### `expected_head` checked before the mutation

The changeset request accepts an expected head revision and rejects a mismatch during preflight.

It also performs a final head read before updating the ref.

That protects against many stale writes, but the final equality test and the ref mutation are separate GitHub operations.

Git's expected-old-OID primitive performs both together.

Assessment: **direct weaker duplication**.

### Ref update performed through REST with `force:false`

The final GitHub ref write uses the REST update-ref shape with a new SHA and `force:false`.

`force:false` enforces fast-forwardability. It does not express the stronger predicate:

```text
current ref must equal the exact OID I observed
```

Assessment: **useful but insufficient as the exact-revision linearization point**.

### Pre-write reread and post-failure readback

Because the final write lacks an expected-old OID, Overcenter rereads the ref to detect races and performs readback after ambiguous failures to infer whether its candidate landed.

Readback remains necessary for genuinely ambiguous network outcomes even with CAS, but some of today's race-classification machinery exists because the final write itself is weaker than Git's native conditional update.

Assessment: **partly compensatory duplication**.

### Branch-creation race handling

Overcenter separately detects whether a branch appeared between preparation and creation.

Git expresses the creation precondition naturally with an expected zero OID.

Assessment: **can collapse into native conditional ref creation**.

### Immutable commit construction treated as authoritative mutation uncertainty

Current recovery bookkeeping treats commit-object creation as a potentially mutating phase and can mark the provider operation indeterminate once the commit object is created.

That is conservative at the API-effect level, but too coarse at the authority level.

An unattached commit object is prepared candidate state. The authoritative repository transition occurs when a ref is advanced to it.

Assessment: **overstates repository-authority ambiguity**.

### Sequential coordination where atomic ref updates are available

Any operation that needs several Git refs to move as one logical repository transition should prefer Git ref transactions, atomic push, or GitHub GraphQL `updateRefs` rather than sequencing writes and repairing partial success.

Assessment: **native stronger primitive exists**.

### Exact Git authority represented by additional hashes

Where an Overcenter hash exists only to represent the exact repository revision, the Git OID is already the canonical content-addressed identity.

Semantic fingerprints should remain when they intentionally describe domain semantics rather than exact repository bytes.

Assessment: **potential duplicate identifier, depending on purpose**.

## 12. Summary table

| Overcenter mechanism | Git primitive | Recommendation |
| --- | --- | --- |
| `expected_head` preflight | expected old OID | Keep as early rejection only; move correctness to CAS |
| reread immediately before ref update | compare-and-swap | Do not rely on reread for atomicity |
| REST ref update with `force:false` | exact expected-old ref update | Prefer GraphQL `updateRefs` / native CAS semantics |
| branch-creation race handling | zero-old-OID create | Collapse into conditional creation |
| sequential multi-ref updates | ref transaction / atomic push / `updateRefs` | Use native atomic grouping |
| commit creation marked authoritative-ambiguous | immutable object preparation | Separate candidate uncertainty from authority uncertainty |
| post-error readback | ref readback after ambiguous outcome | Keep, but narrow to the actual ref commit boundary |
| exact repository revision fingerprints | commit OID | Use OID where exact Git identity is the question |
| semantic graph fingerprints | none at Git semantic layer | Keep |
| temporal lease ownership and expiry | none | Keep in Overcenter |
| cross-provider settlement | none | Core Overcenter responsibility |
| cross-provider recovery and receipts | none | Core Overcenter responsibility |

## 13. Recommended repository commit protocol

The minimal stronger protocol is:

```text
1. INSPECT
   Resolve exact old authority A.

2. AUTHORIZE
   Verify current Overcenter lease/generation if the operation is fenced.

3. PREPARE
   Create immutable blobs, tree, and commit C(parent=A).
   Repository authority mutation certainty remains NONE.

4. COMMIT
   Atomically update the authoritative ref:
       beforeOid = A
       afterOid  = C

5. CLASSIFY
   CAS mismatch:
       deterministic stale-repository-authority failure
       may_have_mutated_authority = false

   success response:
       authority transition confirmed

   transport/result ambiguity:
       may_have_mutated_authority = true
       reconcile exact ref state

6. CONFIRM
   Verify the ref and required evidence.
   Persist settlement/receipt.
```

The remaining ambiguous case is unavoidable in any remote system:

```text
server commits A -> C
network fails before client receives response
```

CAS does not remove that uncertainty for the disconnected client. It makes the recovery question much narrower.

Readback can classify:

```text
ref == C
    -> our transition committed

ref == A
    -> our transition did not commit

ref == something else
    -> concurrent authority exists;
       classify using ancestry and transaction evidence
```

This is the appropriate boundary for Overcenter's mutation-certainty and recovery machinery.

## 14. What Git already gives Overcenter

Git already provides:

```text
immutable candidate state      objects
exact snapshot identity        object IDs
causal history                 commit parents
optimistic concurrency         expected-old OIDs
repository stale-state fence   compare-and-swap
atomic grouped ref writes      ref transactions
remote grouped atomicity       atomic push
GitHub-hosted ref CAS          GraphQL updateRefs/beforeOid
local transition history       reflogs
```

Overcenter should not rebuild these at a weaker semantic layer.

## 15. What remains genuinely Overcenter's job

Git deliberately does not solve several problems that define Overcenter's actual product value:

```text
                    Git
                     |
        exact repository transition
                     |
                     v
              +------------+
              | Overcenter |
              +------------+
              /      |       \
             /       |        \
        temporal   external   semantic
         leases     effects    project
        & claims   & recovery   state
```

Overcenter still needs to own:

- temporal lease ownership and fencing generations;
- authorization of which worker may attempt an authoritative effect;
- orchestration across GitHub, CI, issue trackers, hosting, and other providers;
- settlement when several systems cannot participate in one atomic transaction;
- receipts and evidence for effects Git cannot represent;
- recovery when a remote mutation's outcome is unknown;
- semantic graph/frontier/project-transition state;
- compatibility judgments across graph revisions;
- fail-closed handling of irreducibly ambiguous distributed state.

## Architectural takeaway

The strongest conclusion is not "use Git instead of Overcenter."

It is:

> Git already solved much of the repository-local half of Overcenter's problem. Overcenter should stand on those guarantees instead of simulating them one API layer above GitHub.

The design pressure should be:

1. treat immutable object creation as preparation;
2. treat conditional ref advancement as the repository transaction commit;
3. carry the exact observed OID into that mutation;
4. use atomic multi-ref updates when repository-local state must move together;
5. preserve Overcenter's fencing, evidence, settlement, and recovery machinery only where Git's transaction boundary actually ends.

That sharpens Overcenter's role from a second transaction implementation for Git into the higher-level system Git is intentionally not: **a transaction, evidence, and recovery layer spanning repository state, agent authority, time, and external systems.**
