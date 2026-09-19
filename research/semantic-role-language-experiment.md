# Semantic role language experiment

## Result

The semantic-coherence experiment in `experiments/lisp-semantics/` showed that one declarative role assignment can derive several specialized verifier projections together and reject drift that independently maintained projections can permit.

The follow-up Common Lisp experiment in PR #78 tested whether a real macro system improved the implementation enough to justify another language/runtime.

It did not.

At exact head `72f40250110ee548d05de1b658118d3965598a51`, GitHub Actions completed the Common Lisp semantic macro proof, the ordinary Evidence workflow, and the disposable-agent trust proof successfully. The dedicated macro proof used SBCL 2.2.9 and the hostile suite reported 21 checks passed.

The useful properties survived:

- coordinate roles drove effect-resource identity and absence subject/scope coherently;
- context fields stayed outside those identities;
- invalid desired/output/settlement combinations failed closed;
- arbitrary top-level Lisp was rejected;
- `*READ-EVAL* NIL` blocked read-time `#.` execution;
- trusted higher-level macros could expand into the validated core.

But the trusted implementation did not become smaller.

| directly comparable mechanism | nonblank, noncomment lines |
| --- | ---: |
| TypeScript parser + semantic compiler | 86 |
| Common Lisp macro semantic core | 101 |
| Common Lisp core + safe declaration reader | 124 |

Keeping semantic declarations non-executable required a safe reader, a top-level whitelist, controlled macro expansion, package-neutral syntax, and an additional SBCL toolchain. A TypeScript helper can construct the same canonical IR without enlarging the language/toolchain surface.

## Decision

The semantic-role abstraction earned further investigation. Common Lisp did not earn a production role from this experiment.

Preserve the role model and canonical IR idea. Test it against every real Overcenter verifier in TypeScript before moving any abstraction into the trusted core. The next experiment must preserve meaningful distinctions among observation identity, provider authority, effect identity, canonicalization, desired state, output identity, and absence evidence rather than flattening them into one generic coordinate concept.

PR #78 remains the detailed negative experiment record and should stay unmerged.
