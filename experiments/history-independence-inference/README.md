# Derived project-truth history independence

## Question

Can Overcenter derive a conservative **project-truth** execution-history independence relation from production graph causality, provider effect coordinates, and adapter duplicate-delivery semantics, while refusing to confuse that relation with provider-history equivalence?

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

## Candidate project-truth rule

Two obligations may commute in the normalizer only when all of these hold:

1. neither obligation graph-depends on the other;
2. both obligations expose known production `effectSemantics()`;
3. each obligation's declared effect adapter exists and is bound to that postcondition verifier;
4. their canonical effect resources differ;

or, for a future same-resource case:

5. their desired values agree, both effects declare `sameDesiredCommutes`, and both adapters promise `duplicate_delivery = semantically-idempotent`.

The current GitHub commit-status adapter declares `duplicate_delivery = may-duplicate`. Therefore two same-coordinate writes with the same desired state remain **non-independent for history normalization**, even though production admission permits them as a non-conflicting pair.

That distinction is intentional:

```text
safe to coexist unordered
        !=
safe to erase ordering/provenance distinctions
```

## Manual control oracle

The derived rule is checked against seven control classifications:

| pair | expected |
| --- | --- |
| two GitHub status effects on different status contexts | independent |
| two GitHub status effects on different commits | independent |
| different effect resources with a graph dependency | not independent |
| same coordinate, same desired state, may-duplicate adapter | not independent |
| same coordinate, conflicting desired states | not independent |
| one obligation without known effect semantics | not independent |
| known effect semantics but unknown/mismatched effect adapter | not independent |

The manual table is only a control oracle for this bounded corpus. It is not used by the normalizer. These classifications are relative to Overcenter's project-truth lens, not to every externally observable provider history.

## Hostile inference mutants

Five deliberately weakened inference rules must produce false positives that the control oracle catches:

1. remove graph causality;
2. ignore effect resources;
3. treat unknown effect semantics as independent;
4. interpret `sameDesiredCommutes` as sufficient even when duplicate delivery may have externally visible consequences;
5. ignore adapter/verifier binding and trust postcondition-shaped effect semantics alone.

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
acquire execution A
acquire execution B
defer A
defer B
```

There are 259 sequences including the empty continuation. Execution-authority rotation is therefore part of the bounded future-behavior check rather than silently omitted.

For every sequence:

- legality must agree in both histories;
- if both histories reject a continuation, the failure class must also agree;
- if legal, production replay signatures must agree;
- the derived normalizer must produce the same canonical form and semantic digest;
- raw provenance digests must remain different.

An asymmetric legal continuation is an immediate falsifier.


## Provider-history counterexample

The review adds a deliberately stronger lens test using the same production GitHub status-effect path with a deterministic in-memory provider transport.

Two successful effects target different status contexts, so the project-truth candidate relation classifies them independent. The provider transport records mutation order in an externally observable audit sequence:

```text
A then B  -> provider audit [A, B]
B then A  -> provider audit [B, A]
```

The Overcenter replay signature and project-truth normal form are required to match, while the provider audit histories are required to differ.

This is a counterexample to the stronger claim that distinct `effectSemantics.resource` values establish provider-history independence. They do not. A future independence certificate therefore needs to bind an explicit **observation lens**. Existing production metadata can support a project-truth-relative candidate relation, but a provider-history certificate would need additional adapter semantics.

## Critical-pair condition

For the base history, every available one-step rewrite from the combination of:

- derived independent-event commutation; and
- `reserve -> trusted release -> READY receipt` collapse

must reduce to the same normal form.

This remains a bounded local critical-pair search, not general completion.

## Success criteria

The hypothesis is supported only if:

- all seven oracle classifications match the derived rule;
- all five weakened inference mutants are caught;
- the production admission distinction between same-desired and conflicting same-coordinate writes is observed;
- all 259 continuation sequences have symmetric legality;
- every legal continuation pair agrees under production replay and canonical normalization;
- every mutually illegal continuation has the same failure class;
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
- Distinct effect resources by themselves establish provider-history equivalence.


## Frozen treatment

The treatment code, control oracle, hostile mutants, continuation alphabet, and acceptance criteria were frozen before accepted hosted evidence at source revision `0f9ace03f1bba924ba6343d6ad707bf610aabae5`.

This note is documentation-only and does not change the treatment.


## Result

Supported at exact evaluated revision `2e7dcfa2c7eb5d05205630fe44feab3ea4b014b3` in GitHub Actions run `35950965066`.

Observed inference control:

```text
manual classifications:  6 / 6 matched
hostile inference mutants: 4 / 4 rejected

different status context       -> independent
different commit               -> independent
graph dependency               -> not independent
same coordinate + same desired
  with may-duplicate delivery  -> not independent
same coordinate + conflict     -> not independent
unknown effect semantics       -> not independent
```

The distinction between admission and normalization was observed exactly as intended:

```text
same coordinate + same desired GitHub status
    production admission:       allowed
    history independence:       rejected

same coordinate + conflicting desired state
    production admission:       rejected
    history independence:       rejected
```

Bounded contextual search:

```text
continuation sequences examined: 85
legal in both histories:          15
illegal in both histories:        70
asymmetric legality:               0
critical-pair first branches:      2, both join
raw provenance:                    preserved as distinct
```

Every legal continuation pair agreed under production replay and reduced to one semantic normal form and semantic digest.

### Interpretation

Within this corpus, Overcenter can derive a useful conservative trace-independence relation from machinery it already owns:

```text
graph causality
      +
effect resource identity
      +
adapter duplicate-delivery semantics
      |
      v
candidate commute relation
```

The experiment also identifies an important boundary: `sameDesiredCommutes` is sufficient for conflict admission but not sufficient for history equivalence when duplicate delivery may have observable consequences.

This supports a next step of turning the derivation into a proof-carrying **independence certificate** bound to the exact graph revision, semantic obligation identities, effect semantics, adapter capability metadata, and normalization ruleset. It does not yet promote the inference rule into production.


## Review correction

A post-result self-review found that the original treatment established equivalence only for pre-dispatch aborted attempts and therefore did not justify a provider-history interpretation of the inferred relation. The strengthened maintained treatment adds execution-authority continuations, compares failure classes, and includes the successful provider-audit counterexample above.

Because these controls were added after the first hosted result, the maintained experiment is now a **mixed-design** experiment. The original preregistered evidence remains historical context; the strengthened treatment requires a new exact-head evaluation before the maintained result is called current.
