# Lean obligation-key preimage audition

## Question

The semantic-identity experiment moved selector meaning and evidence binding into Lean, while TypeScript still constructs the final obligation-key object and hashes it with `canonicalDigest`.

This experiment attacks that remaining semantic composition boundary:

> Can Lean construct the exact canonical obligation-key preimage bytes from normalized obligation facts and derived semantic identity material, leaving TypeScript responsible only for SHA-256?

The current TypeScript control computes:

```ts
canonicalDigest({
  id: work.id,
  packet: work.packet,
  postcondition: work.postcondition,
  semantic_dependencies: consumed.sort(
    (a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
  ),
})
```

where each consumed semantic dependency is:

```json
{
  "consumes": { "kind": "...", "selector": "..." },
  "identity": "..."
}
```

and `canonicalDigest` recursively sorts every object key before `JSON.stringify`, then applies SHA-256.

## Frozen boundary

Lean receives:

- obligation `id`;
- the persisted JSON `packet`;
- the persisted JSON `postcondition`;
- semantic dependencies with:
  - `consumes.kind`;
  - `consumes.selector`;
  - identity material derived by the preceding Lean semantic-identity experiment.

Lean must:

1. reject any unresolved semantic dependency;
2. encode each semantic identity into the exact current identity string;
3. sort semantic dependency records deterministically;
4. construct the complete obligation-key object;
5. recursively canonicalize all JSON object keys;
6. serialize that object into the exact bytes that are hashed.

TypeScript may provide only a semantic-free SHA-256 primitive over byte strings chosen by Lean.

That primitive may be invoked for nested semantic identities whose **current** representation is itself a SHA-256 digest, and once for the final obligation-key preimage:

```text
Lean chooses bytes ──> SHA256(bytes)
                       ^
                       |
                 no structure,
                 no selector logic,
                 no canonicalization
```

This correction is committed before challenger implementation because the existing GitHub and Kubernetes semantic identity formats are already SHA-256 digests. Requiring exactly one SHA-256 invocation would make exact current-key parity impossible without separately auditioning a Lean SHA-256 implementation.

TypeScript may also remain the differential oracle for the current implementation.

Lean must not receive:

- `obligation_key`;
- `preimage_json`;
- `semantic_dependencies_sorted`;
- a precomputed final identity list.

## Null hypothesis

Keep obligation-key composition in TypeScript.

Lean earns the boundary only if all of the following hold:

1. **Exact key parity.** SHA-256 of Lean's preimage bytes equals the current TypeScript `obligationKey` for every shared case.
2. **Order independence.** Reordering declaration order of semantic dependencies does not change the preimage or final key.
3. **JSON completeness.** Nested packet objects, arrays, booleans, nulls, integers, strings, Unicode strings, and Unicode object keys are exercised.
4. **No hidden semantic preprocessing.** The caller cannot provide a sorted dependency list, final semantic identity strings, or canonicalized packet/postcondition bytes.
5. **Fail closed.** Missing or duplicate semantic identities, unsupported semantic selectors, malformed JSON shapes, or unresolved dependencies produce no preimage.
6. **Generic invariant.** Lean proves that successful preimage construction contains exactly the obligation identity material and only resolved semantic dependencies.
7. **Only hashing remains outside.** Every byte string passed to SHA-256 is constructed by Lean; TypeScript performs no semantic selection or canonicalization.

## Canonicalization adversary

The current TypeScript implementation uses JavaScript `localeCompare` when recursively sorting object keys and when sorting semantic dependency records.

That is part of the null hypothesis, not an assumption of correctness.

The hostile suite must include keys and dependency material that distinguish locale-sensitive ordering from simple code-point / code-unit ordering. If the current TypeScript implementation cannot define portable canonical bytes across runtimes or locales, that is a finding against the current canonicalization contract, not permission to silently narrow the input domain.

A discovered canonicalization defect may lead to:

- a corrected language-independent canonicalization contract tested in both implementations; or
- the conclusion that this boundary is not ready to migrate.

Any correction must be explicit and separately evidenced because changing canonical bytes changes obligation keys.

## Hostile cases fixed before implementation

At minimum:

1. no semantic dependencies;
2. one verified-content dependency;
3. one settlement-receipt dependency;
4. multiple semantic dependencies supplied in opposite declaration orders;
5. duplicate semantic dependency records;
6. same upstream with distinct selectors;
7. nested packet objects whose insertion order differs;
8. packet arrays where array order must remain significant;
9. packet booleans, null, integers, empty strings, and escaped strings;
10. Unicode packet values;
11. Unicode packet object keys chosen to challenge `localeCompare`;
12. all current postcondition families;
13. unresolved semantic dependency;
14. unsupported selector;
15. caller-provided `preimage_json` or `obligation_key` rejected.

## Possible outcomes

- **TypeScript retains obligation-key composition.**
- **Lean earns exact obligation-key preimage construction; SHA-256 remains TypeScript.**
- **Canonicalization contract is defective:** neither implementation should be promoted until a language-independent byte-level contract replaces the current behavior.

No broader language migration follows automatically.


## Falsification found before control correction

First compiled challenger head:

`c20fcfadeb4d0fe472d373a3200f8dcef5c2ba7a`

Dedicated run `35425839111` produced:

- Lean proof library: **PASS**
- obligation-key executable: **PASS**
- 9/10 differential cases: **PASS**
- Unicode object-key portability case: **FAIL**

The exact-key mismatch was:

```text
Lean       b8d140f43be5d9c40339c221d5f038cf89dd350a3398ed3e908aa80f0e95344d
TypeScript b34c0fd339630fc8f1a30f909ea6d1e8fa6193a98064b68946ffee8af6ab2b9a
```

This is attributable to the current TypeScript canonicalizer's use of `String.localeCompare` for recursive object-key ordering. Locale collation is not an acceptable byte-level identity contract for a durable key intended to be reproduced across implementations.

The same hostile suite also confirmed a separate syntax-sensitivity issue: an exact duplicate semantic edge is accepted by current TypeScript and changes the obligation key, while graph traversal already collapses duplicate upstreams. The challenger rejects exact duplicate semantic edges.

Before judging the language audition, the TypeScript null hypothesis will therefore receive two explicit contract repairs:

1. replace locale collation with a specified Unicode-scalar lexical comparator used by canonicalization and semantic-dependency sorting;
2. reject exact duplicate dependency records at obligation validation.

These are not Lean accommodations. They remove behavior that is unsuitable for a provider- and language-independent durable identity. The repaired TypeScript implementation remains the control for the final audition.

Changing canonical ordering can change keys for obligations whose JSON object keys sort differently under the old locale-sensitive rule. A production migration would therefore require an explicit compatibility / key-version plan. This research branch does not silently claim migration compatibility.
