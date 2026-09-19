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

TypeScript may do exactly one semantic-free final operation:

```text
SHA256(preimage_bytes)
```

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
7. **Only hashing remains outside.** The successful boundary output is the exact byte string consumed directly by SHA-256.

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
