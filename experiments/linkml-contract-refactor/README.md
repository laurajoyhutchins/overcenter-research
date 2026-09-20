# LinkML contract-refactor experiment

## Question

Can stock LinkML generation replace real `SettlementObservation` structural
manifestations without weakening them?

This experiment uses the current
`contracts/observation-evidence-v1` `SettlementObservation` envelope as the
control. It does not modify the production contract.

## Production manifestations under test

The relevant shape is independently maintained in three places:

```text
contracts/observation-evidence-v1/schema.json
src/model.ts :: Observation
src/observation.ts :: validateObservationEnvelope()
```

The experiment reads those live repository files. The intentionally open
`absence_evidence` and `provider_evidence` fields are outside the comparison.

## Correction to the earlier result

The first version of this experiment reported a 3-to-2 reduction in
independently maintained manifestations. That conclusion was too strong for two
reasons discovered during the production-adoption attempt:

1. the LinkML model omitted the explicit `linkml:types` import, so
   built-in-looking scalar ranges could generate as unconstrained JSON Schema;
2. the stock LinkML TypeScript generator emits enum declarations but types
   enum-valued interface slots as `string`, widening Overcenter's
   `verifier`, `mutation_certainty`, and `provider` types.

The original test compared field names and requiredness, so it did not detect
either semantic loss. Its 3-to-2 claim is superseded.

## Corrected experiment

The model now explicitly imports `linkml:types`. The JSON Schema projection is
generated with `include_null=False`, matching Overcenter's convention that
optional properties may be absent but are not implicitly nullable.

The corrected proof requires generated JSON Schema to preserve:

- verifier enum values;
- mutation-certainty enum values;
- provider enum values;
- string scalar typing;
- repository ID integer type;
- repository ID minimum and maximum bounds.

It separately demonstrates the TypeScript limitation rather than hiding it:

```text
production Observation.verifier
    Postcondition['verifier']

stock LinkML projection
    verifier: string
```

## Hostile refactor

The hypothetical change remains deliberately boring:

```text
SettlementObservation
  + observer_generation?: integer
```

A single LinkML edit moves JSON Schema and TypeScript field vocabulary together,
but that does not make the TypeScript projection faithful. The real runtime
validator also remains an independent deterministic boundary and rejects the new
field until explicitly updated.

## Measured architecture

Without a custom TypeScript generator or template:

```text
current
  JSON Schema + TypeScript + runtime validator
      3 independent authored manifestations

faithful stock-LinkML target
  LinkML source -> generated JSON Schema
  handwritten narrow TypeScript
  runtime validator
      3 independent authored manifestations
```

So the corrected manifestation reduction is **3 -> 3 (zero)**.

That does not make LinkML useless. It means the evidence supports a narrower
role: LinkML can own the tested JSON Schema structural source, but has not earned
authority over the TypeScript domain model.

## Reproduction

Requires LinkML 1.11.1 and Node.js from `.node-version`:

```sh
python3 -m pip install 'linkml==1.11.1'
npm run test:linkml-contract-refactor
```

## Success criteria

A green result requires:

- current production field vocabulary and requiredness agree;
- generated JSON Schema preserves the tested enums, scalar types, and numeric
  bounds;
- stock generated TypeScript is explicitly demonstrated to widen enum-valued
  fields rather than being credited as faithful;
- the hostile new field propagates through generated field vocabulary;
- the real runtime validator remains independently fail-closed;
- the faithful stock-LinkML architecture is measured as three independently
  maintained authored manifestations, not two.

## Observed corrected result

Exact-head run `35481664991` passed 6/6 tests at
`cd0d2deb96b83d82ad321d67af065ea89bcabf8c`.

```text
JSON Schema semantic fidelity     PASS
stock TypeScript enum fidelity    FAIL (demonstrated negative result)
runtime validator independence    PASS
independent manifestations        3 -> 3
```

The earlier 3-to-2 result is superseded, not additive evidence.

## Interpretation

A positive result supports LinkML as a source for the tested JSON Schema
structural definition. It does **not** support replacing Overcenter's narrow
TypeScript domain types with stock LinkML output.

A custom TypeScript template might change that conclusion, but adding and
maintaining such a template is a separate implementation with its own cost and
failure modes and requires separate evidence.

## Non-claims

This experiment does not prove that:

- LinkML represents provider-owned open payload semantics;
- LinkML should generate the production runtime validator;
- stock LinkML TypeScript is faithful to Overcenter enum types;
- a custom LinkML template would be simpler than the handwritten TypeScript;
- LinkML owns verifier semantics, settlement authority, or evidence meaning.

<!-- exact-head-proof-trigger -->
