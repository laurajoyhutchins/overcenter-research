# LinkML ontology experiment

## Question

Can LinkML act as the canonical source for Overcenter's **structural ontology**
without quietly becoming authority for temporal, evidentiary, or settlement
semantics?

The bounded claim is:

> For a representative Overcenter ontology slice, LinkML 1.11.1 can define one
> vocabulary/shape model, project it into multiple useful representations, and
> reject structural contradictions. JSON Schema and TypeScript are byte-stable
> in the tested toolchain; SHACL is compared as an RDF graph because raw Turtle
> ordering is not byte-stable. Cross-record semantic identity remains an
> explicit Overcenter invariant outside LinkML.

This is an audition, not an adoption.

```text
                 ontology.yaml
                     LinkML
                       |
          +------------+------------+
          |            |            |
          v            v            v
     JSON Schema   TypeScript      SHACL
          |
          v
 structural validation

          separate boundary

 semantic identity / authority / temporal truth
          |
          v
 deterministic Overcenter software
```

## Representative slice

The experiment models six concepts:

- `Obligation`
- `MaterialInput`
- `Attempt`
- `Evidence`
- `Settlement`
- `OntologySlice`

The names are intentionally close to production language, but the model is not
a production schema.

## Hostile cases

The executable test asks five different questions.

1. Does the LinkML schema validate against the LinkML metamodel?
2. Does a valid instance pass while a settlement with no evidence fails?
3. Does an undeclared `self_certified` relation fail rather than silently
   becoming vocabulary?
4. Does renaming the `Settlement.evidence` relation change JSON Schema,
   TypeScript, and the SHACL RDF graph from the same source?
5. Can a structurally valid but semantically stale settlement pass LinkML while
   an independent semantic check rejects it?

The fifth case is deliberately expected to pass LinkML validation:

```text
Settlement.semantic_key = K1
Evidence.semantic_key   = K0
               |
               v
       LinkML: structurally valid
       Overcenter: semantically invalid
```

That is the desired boundary. LinkML should not be credited with guarantees it
does not provide.

The test also changes only the minimum cardinality of settlement evidence and
reports which generated projections preserve that distinction. JSON Schema and
SHACL are required to preserve it. TypeScript is measured rather than presumed
to encode runtime cardinality.

`linkml:types` is imported explicitly; built-in-looking range names are not
accepted as evidence that the corresponding generator constraint exists. The
experiment also asserts concrete scalar fidelity (`string` and `boolean`) in
generated JSON Schema and TypeScript; field-name agreement alone is not accepted
as structural fidelity.

## Plausible contrast

The current alternative is to hand-maintain vocabulary and structural
constraints independently across TypeScript types, JSON/data contracts, docs,
and any graph-oriented representation.

A hand-built Overcenter schema compiler could also make one model authoritative,
but it would add custom parser, generator, compatibility, and maintenance code.
This experiment does **not** estimate that hypothetical implementation cost. It
tests whether LinkML already supplies enough useful projection behavior to make
such custom machinery unnecessary.

## Reproduction

Requires:

- Node.js from `.node-version`;
- Python compatible with LinkML 1.11.1;
- LinkML 1.11.1 on `PATH`.

Install the pinned LinkML release and run:

```sh
python3 -m pip install 'linkml==1.11.1'
npm run test:linkml-ontology
```

The hosted workflow downloads the exact LinkML 1.11.1 wheel and verifies its
published SHA-256 before installation. The root LinkML package is pinned; Python
transitive dependencies remain normal package-manager resolution and are
printed with `pip freeze` in the workflow log.

## Success criteria

A green experiment means all of the following:

- the schema itself validates;
- the valid fixture passes;
- missing required evidence fails;
- undeclared vocabulary fails;
- repeated JSON Schema and TypeScript generation is byte-identical within the
  same pinned toolchain run;
- repeated SHACL generation is RDF-isomorphic even when Turtle statement order
  varies;
- a relation rename propagates to all three tested projections at their
  meaningful representation level;
- JSON Schema and SHACL preserve a minimum-cardinality change;
- the semantic-key mismatch is accepted structurally and rejected by the
  independent semantic check.

## Interpretation

If green, LinkML has evidence for a narrow role:

```text
canonical structural vocabulary
          +
projection generator
          +
structural validator
```

It does **not** thereby become Overcenter's semantic oracle or project-truth
authority.

### Earlier evidence correction

A later production-adoption attempt exposed a hole in the original experiment:
without an explicit `linkml:types` import, built-in-looking ranges such as
`string` could project to unconstrained JSON Schema objects. The original tests
checked names, cardinality, and change propagation but did not assert scalar
fidelity. This experiment has been strengthened accordingly; evidence from the
pre-correction revision is superseded.

### Observed serializer caveat

The first exact-head run falsified a stronger byte-reproducibility hypothesis:
two `gen-shacl` invocations produced RDF-isomorphic graphs with different
Turtle property ordering. The experiment therefore compares SHACL semantically,
not byte-for-byte. Raw generated SHACL should not be used as an exact artifact
digest unless Overcenter adds an explicit RDF canonicalization step.

A useful next experiment, if this one is positive, would compare the maintenance
surface of generated LinkML projections against the existing hand-maintained
contract manifestations in a real refactor.

## Non-claims

This experiment does not show that:

- LinkML can express Overcenter's temporal or transactional semantics;
- LinkML replaces Datalog, Lean, or deterministic TypeScript semantic checks;
- generated TypeScript provides runtime validation;
- every LinkML generator preserves every source constraint;
- documentation cannot drift unless documentation is itself generated or
  mechanically checked;
- LinkML belongs in the production runtime;
- LinkML should become authoritative before a production-facing differential
  experiment.

