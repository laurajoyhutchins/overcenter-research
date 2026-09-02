# Distributed Fencing

## Question

If a worker loses its lease, stalls, wakes up later, and attempts to commit an otherwise valid result, what exact mechanism must reject it?

For Overcenter, the answer is:

> A stale worker must be rejected at the authoritative mutation boundary by a monotonically increasing fencing generation. Git revision checks remain a separate compare-and-swap predicate. The two checks compose; neither replaces the other.

The minimal model is:

```text
may_commit =
    current_lease_authority(subject, lease_ref, authority_epoch)
    AND
    git_revision == expected_git_revision
```

These predicates protect different dimensions:

| Lease fence | Git revision | Meaning |
| --- | --- | --- |
| stale | current | Reject. Correct repository state, wrong worker. |
| current | stale | Reject. Correct worker, wrong repository state. |
| current | current | Mutation may proceed. |
| stale | stale | Reject for both reasons. |

The first row is the critical distributed-fencing case.

```text
Git HEAD = H

Worker A acquires lease      epoch 41
Worker A stalls
lease expires
Worker B acquires lease      epoch 42
Git HEAD is still H

Worker A wakes:
    expected Git HEAD = H    yes
    authority epoch = 41     no, current is 42

                         FENCE HERE
                            |
                            X
                     no authoritative
                       Git mutation
```

Git's exact-revision check cannot reject this stale worker because a new lease acquisition does not necessarily change Git.

## Prior art

### Chubby

Chubby does not treat lease expiry alone as sufficient protection. A lock holder can obtain a **sequencer** containing the lock generation, and protected operations carry that sequencer so the receiving service can determine whether the caller still owns the relevant generation.

The architectural lesson is important: the coordination service announcing that a lease expired is not enough. The component accepting the dangerous write must participate in fencing.

Reference: Burrows, *The Chubby lock service for loosely-coupled distributed systems*, OSDI 2006.

https://www.cs.princeton.edu/courses/archive/fall09/cos518/papers/chubby.pdf

### ZooKeeper

ZooKeeper recipes commonly use ephemeral sequential znodes to establish ordered ownership. The sequence number gives a monotonically ordered coordination primitive, but an external storage system does not automatically know that an old client has lost leadership.

If the protected resource lives outside ZooKeeper, the resource or an intermediate mutation service must still reject obsolete ownership generations.

Reference: Apache ZooKeeper Recipes and Solutions.

https://zookeeper.apache.org/doc/current/recipes.html

A useful exposition of the external-resource problem is Martin Kleppmann's discussion of fencing tokens in distributed locking:

https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html

### etcd

etcd's concurrency primitives expose revision-based ownership. Its mutex implementation records the creation revision of the lock key and can test ownership transactionally against that revision.

This illustrates the easiest case: when coordination state and the protected mutation live in one transactional system, ownership validation and mutation can be composed atomically.

Reference: etcd client concurrency mutex implementation.

https://github.com/etcd-io/etcd/blob/main/client/v3/concurrency/mutex.go

### HDFS Quorum Journal Manager

HDFS QJM is one of the clearest examples of storage-level fencing. JournalNodes remember the highest writer epoch they have promised to accept. Requests from lower epochs are rejected by the storage nodes themselves.

That is the desired semantic shape for Overcenter: the authoritative mutation gate knows the current generation and refuses an obsolete writer.

Reference: Apache Hadoop HDFS QJM Journal implementation.

https://hadoop.apache.org/docs/r2.8.0/hadoop-project-dist/hadoop-hdfs/api/src-html/org/apache/hadoop/hdfs/qjournal/server/Journal.html

### Database optimistic concurrency

Database optimistic-locking schemes commonly attach a version number to a record and require an update to match the expected version. The update fails if another writer has advanced the version.

That mechanism is analogous to Git's expected-revision compare-and-swap. It protects against stale **state**, not necessarily stale **execution authority**.

Reference: DynamoDB optimistic locking documentation.

https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/BestPractices_OptimisticLocking.html

### Distributed job schedulers and leader election

Leader-election systems frequently distinguish leadership from fencing. Kubernetes' leader-election package explicitly notes that leader election does not itself guarantee that a previous leader has stopped operating.

The scheduler can know that B is the current leader while a paused A later resumes and performs an external side effect. Correctness therefore requires the protected mutation path to recognize stale authority.

Reference: Kubernetes client-go leader election.

https://pkg.go.dev/k8s.io/client-go/tools/leaderelection

## Application to Overcenter

Overcenter should use one monotonic generation per fenced execution subject, conceptually:

```text
lease_ref       = identity/capability for one lease instance
authority_epoch = monotonic fencing generation for the subject
Git SHA         = exact version of repository authority
```

These are deliberately different things.

- `lease_ref` identifies the specific lease and is the natural agent-facing capability.
- `authority_epoch` prevents a superseded lease holder from making an authoritative effect.
- the Git SHA prevents a valid lease holder from committing against repository state other than the state it inspected.

Do not make the fencing token another Git revision. Do not make the Git revision stand in for the fencing token.

## Exact stale-worker mechanism

Suppose worker A receives:

```text
lease_ref = A
authority_epoch = 41
expected_git_revision = H
```

A stalls. Its lease expires. Worker B acquires the same execution subject with epoch 42. Git remains at H.

When A resumes and asks to perform an authority-changing operation, the mutation gateway must read current execution authority and compare it with A's lease identity and epoch:

```text
current subject authority:
    lease_ref = B
    authority_epoch = 42

request:
    lease_ref = A
    authority_epoch = 41
    expected_git_revision = H
```

The gateway rejects the request as stale before calling GitHub.

A useful failure contract is:

```text
PROJECT_TRANSITION_LEASE_STALE
reason: authority_fence_changed
may_have_mutated: false
```

The exact error name is less important than the invariant:

> If the lease generation is stale, the external authoritative mutation must not begin.

## Where the fence belongs

The fence belongs on the **authority-changing edge**, not on arbitrary computation.

A worker that has lost its lease may safely finish local or immutable work. For example, it may finish computing a result or creating immutable content that is not yet authoritative.

It must not, after losing authority:

- advance a protected Git ref;
- merge a change into the authoritative branch;
- record authoritative transition completion;
- promote production;
- publish any other effect whose acceptance represents project truth.

This distinction keeps leases from becoming unnecessarily invasive while still protecting the operations that matter.

## Why `check lease; call GitHub` is still insufficient

A naive implementation has a time-of-check/time-of-use race:

```text
t0  A epoch=41 checks lease        valid
t1  A pauses
t2  lease 41 expires
t3  B acquires epoch=42
t4  A's already-authorized Git request arrives
```

GitHub does not understand Overcenter's fencing generation, so GitHub cannot reject A because of epoch 41. If Git is still at A's expected revision, the Git compare-and-swap may succeed.

Therefore a robust cross-system design needs a small authority reservation around the external effect.

## Minimal fencing model

### 1. Lease acquisition

Maintain a durable `authority_epoch` for each fenced execution subject.

Each new lease ownership generation increments it atomically.

A heartbeat or renewal of the same ownership generation does **not** increment it.

The epoch must not reset merely because the previous lease settled or expired. Otherwise an ABA sequence could make an old generation appear current again.

### 2. Prepare the authoritative mutation

Before making an external authority-changing call, perform one Overcenter transaction that verifies:

- the lease exists;
- `lease_ref` matches current authority;
- `authority_epoch` matches current authority;
- the lease is active according to server-side time;
- the run and subject scopes match;
- no incompatible authoritative effect for the subject is already unresolved.

Then persist an immutable prepared operation containing at least:

```text
subject_key
lease_ref
authority_epoch
expected_git_revision
intended_effect
idempotency_key
```

Once this operation is prepared, the execution subject's authority-changing edge is reserved until the operation's external outcome is resolved.

### 3. Perform the Git mutation

Perform the Git operation using the expected Git revision.

This is the composition point:

```text
lease fence       => is this still the authorized execution generation?
Git revision CAS  => is this still the exact repository state we inspected?
```

Both must hold.

### 4. Confirm

If GitHub reports success, read back authoritative state as required, persist the receipt, settle the transition, and release the prepared reservation.

If GitHub reports a definitive no-effect conflict, mark the prepared operation aborted and release the reservation.

### 5. Recover ambiguous mutations

If the external request might have succeeded but its result is unknown, do not immediately grant a successor authority generation that can perform a conflicting effect.

Keep the prepared operation unresolved and fenced. Recovery should inspect authoritative Git state and determine whether the intended effect happened.

Only after the operation is classified as applied or not applied should the reservation be released and normal lease acquisition resume.

This composes naturally with fail-closed `may_have_mutated` recovery semantics.

## Why the reservation matters

Overcenter cannot make its database transaction and GitHub's ref transaction one ACID transaction. The practical protocol is therefore:

```text
PREPARE authority
        |
        v
    fence subject
        |
        v
Git exact-revision mutation
        |
   +----+-----+
   |          |
   v          v
confirm     ambiguous
   |          |
 settle    recovery/readback
   |          |
   +----+-----+
        |
        v
 release fence
```

This is not full distributed two-phase commit with GitHub. It is a local authority reservation plus deterministic reconciliation of the external effect.

The key rule is:

> Once Overcenter has authorized an external mutation, it must not hand conflicting authoritative mutation rights to another lease generation until the outcome of that mutation is known.

## Recommended invariant

The architectural invariant should be:

> For every authoritative project transition, at most one authority epoch may have an unresolved external mutation, and every authority-changing mutation must be both lease-fenced and exact-revision-fenced before its effect becomes authoritative.

A shorter formulation is:

```text
Authority safety     = lease generation
State safety         = Git revision
Cross-system safety  = prepared effect + recovery
```

## Recommendation for Overcenter

Use the smallest possible fencing model:

1. One durable, monotonic `authority_epoch` per execution subject.
2. Keep `lease_ref` as the agent-facing handle.
3. Resolve `lease_ref` to the current epoch inside trusted Overcenter mutation services.
4. Require the epoch fence immediately before every authority-changing external effect.
5. Keep Git's expected revision as an independent compare-and-swap predicate.
6. Reserve the subject while an authorized external mutation is unresolved.
7. If mutation outcome is ambiguous, fail closed and reconcile before issuing conflicting authority.

Do **not** add a second lease-generation abstraction. Do **not** encode fencing into Git history merely to make the token durable. Do **not** rely on lease expiry, worker cooperation, process cancellation, or Git revision checks alone to stop a stale worker.

The precise safety property is simple:

```text
stale authority => external authoritative mutation never starts
```

If the mutation had already been authorized before authority became stale, its prepared operation owns the boundary until confirmation or recovery determines the outcome.
