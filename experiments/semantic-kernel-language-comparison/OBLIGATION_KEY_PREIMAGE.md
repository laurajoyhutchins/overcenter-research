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


## Final result

**Lean earns obligation-key preimage construction under the repaired language-independent key contract.**

Final evaluated implementation head:

`c3476292abb82bdae2af1b0e2465513f7c08106e`

Exact-head evidence:

- obligation-key preimage PR audition `35426149675`: **PASS**
- parent semantic-identity audition `35426149684`: **PASS**
- parent claim-admission audition `35426149712`: **PASS**
- existing Lean semantic-kernel proof `35426149725`: **PASS**
- repository Evidence `35426149797`:
  - fast deterministic regression: **PASS**
  - adversarial local proofs: **PASS**
  - TLA+ safety proof: **PASS**

The dedicated audition proves parity across:

- every current postcondition family;
- file, eventually-consistent file, GitHub, Kubernetes, and settlement semantic identity paths;
- multiple semantic dependencies supplied in different declaration orders;
- same upstream consumed through distinct selectors;
- nested packet objects;
- arrays whose order remains significant;
- booleans, nulls, integers, empty strings, escaping, Unicode values;
- Unicode object keys;
- integer-like object keys that JavaScript normally reorders during property enumeration;
- unresolved semantic inputs;
- unsupported selectors;
- duplicate dependency rejection;
- forged caller key/preimage data;
- missing, extra, or duplicate SHA-256-oracle responses.

### Generic proof result

The executable Lean kernel now separates key construction into:

```text
buildObligationKeyPreimageModel
        ↓
sorted resolved semantic dependencies
        ↓
serializeObligationKeyPreimage
        ↓
exact preimage bytes
```

Machine-checked theorems establish that successful preimage construction implies:

1. semantic inputs were derivable;
2. exact semantic dependency records are unique;
3. there exists an explicit successfully constructed semantic-dependency model;
4. the returned bytes are exactly the serialization of that model together with the original target `id`, `packet`, and `postcondition`.

This is stronger than a finite parity suite because the structural relationship between successful construction and the serialized identity object is part of the executable proof.

## The TypeScript null hypothesis was improved before it lost

This audition did not compare Lean against a knowingly defective TypeScript implementation.

The hostile suite first falsified the existing TypeScript key contract at head
`c20fcfadeb4d0fe472d373a3200f8dcef5c2ba7a` in run `35425839111`.

Two problems were made explicit:

### 1. Locale-sensitive canonicalization

`String.localeCompare` was being used to decide durable JSON object-key order.

That produced a real cross-language key divergence on Unicode keys:

```text
Lean       b8d140f43be5d9c40339c221d5f038cf89dd350a3398ed3e908aa80f0e95344d
TypeScript b34c0fd339630fc8f1a30f909ea6d1e8fa6193a98064b68946ffee8af6ab2b9a
```

The TypeScript control was repaired to use an explicit Unicode-scalar lexical comparator and a recursive byte-producing canonical JSON serializer.

The serializer does not reconstruct a JavaScript object before `JSON.stringify`, so integer-like keys cannot be silently reordered by JavaScript property-enumeration semantics.

### 2. Duplicate-edge syntax sensitivity

Graph reachability already treats repeated upstream dependencies as set-like, but the previous obligation key hashed exact duplicate semantic edges multiple times.

Stored-obligation validation now rejects exact duplicate dependency records while still permitting distinct selectors against the same upstream.

Both repairs have ordinary TypeScript unit tests independent of the Lean experiment.

After those repairs, Lean still reproduced the corrected TypeScript key byte-for-byte throughout the hostile suite.

## Earned production boundary

The evidence now supports this division:

```text
authenticated provider / durable facts
                |
                v
TypeScript deterministic normalization
  provider parsing / schema validation
  primitive source normalization
                |
                v
Lean semantic kernel
  selector meaning
  realization / receipt binding
  semantic identity material
  nested identity hash preimages
  semantic dependency composition
  canonical obligation-key preimage
  claim admission
                |
                v
SHA-256 primitive
                |
                v
TypeScript integration / durable mutation
  Git / GitHub / Kubernetes transport
  credentials
  CAS / commit mechanics
```

The SHA-256 implementation itself has not been auditioned. Lean chooses every byte string submitted to the hash primitive and validates the oracle response set; it does not need to own cryptographic implementation machinery to own the semantics of identity.

## Migration consequence

The canonicalization repair changes durable identity semantics for inputs whose object-key ordering differs under the old locale-sensitive behavior.

Therefore this result is **not** authorization to silently replace the existing production key algorithm.

Any production adoption needs an explicit key-semantics version or compatibility transition so historical realizations remain interpretable. Old and new key algorithms must not be ambiguously mixed.

## Interpretation

The TypeScript null hypothesis loses this bounded semantic role.

More importantly, the experiment shows why the language boundary is useful: Lean did not merely reproduce the implementation. Trying to reproduce the durable identity contract from another executable semantics forced hidden assumptions about collation, JavaScript object enumeration, and duplicate-edge meaning into explicit falsifiable rules.

TypeScript remains the appropriate default for ordinary integration software. Lean has now earned a coherent proof-bearing semantic core extending through obligation identity composition and claim admission.

The next incision should not be automatic. The remaining TypeScript boundary consists mostly of authenticated external normalization, cryptographic primitives, transport, and durable mutation mechanics. Moving further inward should require a new experiment showing that a semantic judgment still remains on the TypeScript side, rather than migrating deterministic infrastructure simply because Lean can express it.
