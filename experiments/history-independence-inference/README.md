# Derived history independence

## Question

Can Overcenter derive a conservative execution-history independence relation from production graph causality, provider effect coordinates, and adapter duplicate-delivery semantics, then use that relation to normalize real execution histories without a hand-written commute table?

This experiment is stacked on the earlier semantic history-normalization treatment. It does not replace that evidence. It removes one assumption from it:

```text
before:
  human declares A independent of B

this treatment:
  graph + effect semantics + adapter capabilities
                    |
                    v
        candidate independence relation
```

## Candidate rule

Two obligations may commute in the normalizer only when all of these hold:

1. neither obligation graph-depends on the other;
2. both obligations expose known production `effectSemantics()`;
3. their canonical effect resources differ;

or, for a future same-resource case:

4. their desired values agree, both effects declare `sameDesiredCommutes`, and both adapters promise `duplicate_delivery = semantically-idempotent`.

The current GitHub commit-status adapter declares `duplicate_delivery = may-duplicate`. Therefore two same-coordinate writes with the same desired state remain **non-independent for history normalization**, even though production admission permits them as a non-conflicting pair.

That distinction is intentional:

```text
safe to coexist unordered
        !=
safe to erase ordering/provenance distinctions
```

## Manual control oracle

The derived rule is checked against six preregistered classifications:

| pair | expected |
| --- | --- |
| two GitHub status effects on different status contexts | independent |
| two GitHub status effects on different commits | independent |
| different effect resources with a graph dependency | not independent |
| same coordinate, same desired state, may-duplicate adapter | not independent |
| same coordinate, conflicting desired states | not independent |
| one obligation without known effect semantics | not independent |

The manual table is only a control oracle for this bounded corpus. It is not used by the normalizer.

## Hostile inference mutants

Four deliberately weakened inference rules must produce false positives that the control oracle catches:

1. remove graph causality;
2. ignore effect resources;
3. treat unknown effect semantics as independent;
4. interpret `sameDesiredCommutes` as sufficient even when duplicate delivery may have externally visible consequences.

The production admission checker is also used to show the intended difference between conflict admission and normalization equivalence:

- same-coordinate/same-desired GitHub statuses are admitted;
- same-coordinate/conflicting-desired statuses are rejected;
- the normalizer still refuses to call the admitted same-desired pair independent.

## Real history treatment

The positive treatment uses two admitted GitHub commit-status obligations on different canonical status contexts.

Each is executed through the production status-effect path and deliberately fails before TLS `secureConnect`, producing:

```text
claim
reserve
trusted NOT_DISPATCHED release
READY receipt
```

Two physical histories are created:

```text
A aborted; B aborted
B aborted; A aborted
```

The normalizer receives no hand-written pair relation. It calls the derived independence rule for every candidate adjacent commute.

## Bounded hostile continuation search

Starting from both physical histories, the experiment enumerates every action sequence through depth 3 over:

```text
claim A
claim B
defer A
defer B
```

There are 85 sequences including the empty continuation.

For every sequence:

- legality must agree in both histories;
- if legal, production replay signatures must agree;
- the derived normalizer must produce the same canonical form and semantic digest;
- raw provenance digests must remain different.

An asymmetric legal continuation is an immediate falsifier.

## Critical-pair condition

For the base history, every available one-step rewrite from the combination of:

- derived independent-event commutation; and
- `reserve -> trusted release -> READY receipt` collapse

must reduce to the same normal form.

This remains a bounded local critical-pair search, not general completion.

## Success criteria

The hypothesis is supported only if:

- all six oracle classifications match the derived rule;
- all four weakened inference mutants are caught;
- the production admission distinction between same-desired and conflicting same-coordinate writes is observed;
- all 85 continuation sequences have symmetric legality;
- every legal continuation pair agrees under production replay and canonical normalization;
- every tested critical-pair branch joins;
- provenance remains distinct;
- no production source file changes.

## Run

```sh
npm run test:history-independence-inference
```

## Interpretation boundary

A positive result would support moving from hand-declared trace independence toward **mechanically proposed independence with explicit proof obligations**.

It would not yet justify productionizing the relation. The next rung would be a reusable checker that emits an independence certificate bound to:

- exact graph revision;
- exact obligation semantic identities;
- effect-resource derivation;
- adapter capability metadata;
- the normalizer ruleset identity.

## Non-claims

- Arbitrary agent work without registered effect semantics is classified independent.
- Provider-specific side effects are known merely because desired state is equal.
- Same-resource same-desired GitHub status writes are semantically idempotent.
- The bounded continuation search proves contextual equivalence for arbitrary future behavior.
- General Knuth-Bendix completion or global confluence is established.
- Production scheduling, admission, effect execution, replay, or settlement is changed.
