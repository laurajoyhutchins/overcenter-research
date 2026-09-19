# Common Lisp semantic-macro experiment

## Question

Does a real Lisp macro system provide a measurable advantage over the tiny S-expression compiler in `../lisp-semantics/`?

The previous experiment established the useful architectural property: semantic roles declared once can drive observation coordinates, effect-resource identity, absence scope, desired state, and downstream output identity coherently.

This experiment asks a narrower language question:

> Does Common Lisp materially simplify the trusted semantic compiler or enable useful semantic abstraction that the tiny explicit compiler does not provide as cleanly?

## Null hypothesis

Keep the tiny TypeScript S-expression compiler.

A positive result requires more than shorter syntax.

## Candidate

The candidate uses Common Lisp for two things that the TypeScript experiment had to implement itself:

1. the Lisp reader supplies structured forms, eliminating the handwritten tokenizer/parser;
2. `DEFVERIFIER` is a macro that validates semantic relationships and emits inert canonical IR during macro expansion.

The declaration itself is **not loaded as executable Lisp**.

`compile-declaration-string`:

- binds `*READ-EVAL*` to `NIL`;
- reads exactly one top-level form;
- accepts only `DEFVERIFIER`;
- macroexpands that trusted form;
- extracts the quoted IR without evaluating the expansion.

So the boundary is:

```text
untrusted-ish semantic declaration
        |
safe Common Lisp reader
  *READ-EVAL* = NIL
        |
top-level DEFVERIFIER whitelist
        |
trusted DEFVERIFIER macro
        |
quoted canonical IR
        |
existing trusted Overcenter machinery
```

not:

```text
load arbitrary verifier.lisp
        |
execute arbitrary build-time Lisp
```

## Hostile checks

The hosted proof exercises:

1. coordinate roles derive observation/effect/absence coordinates together;
2. a newly added authority coordinate reaches all of those projections automatically;
3. context fields do not contaminate semantic identity;
4. missing desired/output roles fail during macro expansion;
5. missing settlement semantics fail;
6. absence/settlement disagreement fails;
7. arbitrary top-level Lisp is rejected;
8. `#.` read-time evaluation is physically disabled;
9. repeated expansion yields identical IR;
10. a trusted higher-level macro can expand into the validated core without modifying the core semantic compiler.

## The macro-specific test

The last check matters.

A trusted authoring macro:

```lisp
(defcontent-verifier ...)
```

expands into:

```lisp
(defverifier ...)
```

which then expands into inert IR.

That demonstrates layered language construction while retaining one validated semantic core.

A TypeScript helper function could of course construct the same AST. Therefore this is supporting evidence, not a win by itself. The stronger question is whether the total mechanism becomes materially smaller and clearer once parsing and syntax transformation are supplied by the language.

## Safety cost

Macros increase power. Unrestricted loading of semantic Lisp would also increase the trusted build-time execution surface, which would be a poor fit for Overcenter.

The experiment therefore treats the macro implementation as trusted compiler code and semantic declarations as data. If the useful macro advantage disappears under that restriction, that is evidence against adopting Lisp here.

## Success criterion

Common Lisp earns further consideration only if all of these hold:

- it preserves the hostile semantic-coherence guarantees from the first experiment;
- the trusted compiler is materially simpler to audit, not merely differently written;
- declarations remain non-executable data;
- macro composition adds useful abstraction without creating a second semantic authority;
- the runtime kernel remains Lisp-free.

If the only clear improvement is deletion of a tiny parser, the result should be recorded as: **S-expressions earned their keep; Lisp did not.**

## Run

```sh
sbcl --script experiments/lisp-macros/run-tests.lisp
```
