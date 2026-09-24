# Authority storage decomposition

## Question

Can Overcenter separate immutable fact storage from the operation that decides which fact becomes authoritative without changing project semantics?

The current Git reference backend performs semantic fact storage and exact-head serialization in one object. This experiment tries to split those responsibilities without changing KernelCore.

## Preregistered candidate

~~~text
immutable fact objects
SHA-256(content)
create-only and idempotent
        |
        | fact-id
        v
authority-head service
Git commit contains only fact-id
exact expected-head update-ref
        |
        v
authoritative revision
~~~

The experimental SplitAuthorityFactStore adapts those pieces back to the production DurableFactStore contract. Production storage code is not modified.

## Falsifiers

The decomposition is supported only if all of these hold:

1. the composed store satisfies the basic durable fact-store contract;
2. every reachable authority-head commit contains exactly one tree path named fact-id;
3. semantic graph, claim, execution, reservation, release, and receipt payloads never enter the authority-head tree;
4. a stale append may leave a content object behind, but it remains unreachable and absent from replay;
5. eight child processes racing one exact head produce exactly one winner;
6. the race leaves seven losing fact objects unreachable without creating additional authoritative claims;
7. deleting an object referenced by authoritative history produces FACT_OBJECT_MISSING rather than silent omission;
8. copying the immutable-object directory to a fresh replica reproduces normalized authoritative history;
9. a production KernelCore using the split store and the monolithic GitOvercenterKernel produce identical normalized project state, explanations, and receipts over the same two-obligation core-loop workload.

Any violated criterion falsifies the bounded decomposition.

## Why orphan objects are intentional

~~~text
write immutable object
        |
        v
attempt exact-head CAS
       / \
      /   \
    win   lose
     |      |
authority   orphan immutable object
~~~

A loser may leave storage garbage. It may not leave project truth. Garbage collection is intentionally out of scope.

## Run

~~~sh
npm run test:authority-storage-decomposition
~~~

Hosted exact-head execution is in .github/workflows/authority-storage-decomposition.yml.

## Interpretation boundary

A positive result would justify promoting the interfaces:

~~~text
ImmutableFactObjects
AuthorityHead
        |
        v
DurableFactStore composition
~~~

It would not justify promoting the experiment's directory implementation.

The stronger architectural claim would remain narrow: semantic fact publication does not need to share the same transaction boundary as project-authority serialization, provided authoritative history references immutable objects by verified identity and missing referenced objects fail closed.

## Non-claims

This experiment does not establish a production distributed object store, an HA authority-head service, safe garbage collection, multi-region availability, Byzantine resistance, consensus-free authority, portable revision identities, or that Git is the final authority-head transport.

## Result

Supported at exact treatment revision 7546e2b058c8be80faebaa8900a684b794275af3 in GitHub Actions run 35939753458.

Observed result:

~~~text
durable contract:
  authoritative commits:       3
  immutable fact objects:      4
  unreachable stale object:    1
  authority tree paths:        fact-id only
  copied-object replay:        PASS

missing referenced fact:
  outcome:                     FACT_OBJECT_MISSING
  authority head:              retained

kernel differential:
  before core loop:            EQUIVALENT
  after core loop:             EQUIVALENT

same-head race:
  contenders:                  8
  winners:                     1
  authoritative claims:        1
  immutable objects:           9
  unreachable loser objects:   7
~~~

The standing merge gate also passed lint, typecheck, experiment contracts, adapter diagnosability, and deterministic regression on the same exact revision.

### Interpretation

Within this bounded treatment, fact publication did not require the same serialization boundary as project truth. Content objects could be written independently before CAS; only the exact-head transition decided which object became authoritative.

The losing objects were garbage, not alternate truth. A referenced object disappearing was treated as a hard integrity failure rather than an empty or skipped transition.

This earns promotion of the decomposition as interfaces. Registry outcome: supported. It does not promote the directory-backed object store or Git as the final production head service.
