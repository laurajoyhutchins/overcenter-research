# Live GitHub settlement-equivalence proof

## Claim under test

For one GitHub commit-status coordinate, repeated writes of the **same desired state** may be physically distinct while remaining equivalent under Overcenter's exact observation and settlement semantics.

This is narrower than provider-effect commutativity.

## Positive cases

The hosted proof performs real GitHub status writes using distinct descriptions and target URLs:

```text
A(success) -> B(success)
B(success) -> A(success)
A(success) || B(success)
```

For each case it requires:

1. GitHub to expose distinct physical status records;
2. the production GitHub observer to read the coordinate;
3. the production verifier to derive the same truth:

```text
mutation_certainty = present
actual_state       = success
verified           = true
```

The three truth values must be byte-for-byte structurally equal.

## Counterexample

The proof then changes the material operation:

```text
success -> failure
failure -> success
```

The production observer must derive different truth:

```text
success -> failure
    expected-success verification = false

failure -> success
    expected-success verification = true
```

If reversing incompatible operations does not reverse the derived project truth, the experiment fails.

## Why this matters

The local settlement-equivalence witness tests prove that the assertion is exactly identified, version-fenced, and tamper-sensitive.

This live experiment supplies the missing independent evidence that the assertion matches actual GitHub behavior for the tested provider contract.

It still does not prove all possible GitHub mutations commute. In particular, descriptions, target URLs, and provider history may differ. The claim is only about the exact observation and settlement semantics exercised here.
