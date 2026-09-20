# TypeBox contract-collapse experiment

## Question

Can TypeBox replace the three independently authored structural manifestations of
`SettlementObservation` with one declaration while preserving the existing
JSON Schema, runtime acceptance, and narrow TypeScript type?

The current authored structure is spread across:

1. `settlement-observation.linkml.yaml`;
2. `Observation` in `src/model.ts`;
3. the structural field/type checks in `validateObservationEnvelope()`.

The checked-in JSON Schema is a generated wire artifact and is not counted as a
separate authored manifestation.

## Candidate boundary

TypeBox may own only the closed structural shape of `SettlementObservation`.

It does **not** own:

- evidence admissibility;
- observation-coordinate binding;
- absence-evidence authority;
- provider payload meaning;
- temporal validity;
- settlement semantics;
- project-truth authority.

`absence_evidence` remains a reference to the separately owned
`AbsenceEvidenceEnvelope`. `provider_evidence` remains explicitly
provider-owned.

## Toolchain

The hosted experiment pins:

- `typebox==1.3.34`;
- `typescript==7.0.2`.

The experiment does not add either package to production dependencies.

## Proofs

The experiment requires all of the following:

- the TypeBox value serializes byte-semantically to the current
  `SettlementObservation` JSON Schema definition;
- TypeScript proves bidirectional assignability between the existing
  `Observation` interface and `Type.Static<typeof SettlementObservation>`;
- hostile static fixtures reject stale enum vocabulary and unknown fields;
- TypeBox runtime validation agrees with the current handwritten envelope
  validator across representative valid and hostile values;
- field-addition, enum-narrowing, and numeric-bound mutation probes alter runtime
  admission directly from the same schema value;
- the measured authored structural source is smaller and the independently
  authored manifestation count falls from 3 to 1.

## Interpretation

A positive result establishes an adoption candidate for this structural slice,
not a repository-wide migration. A production change would still need to prove
that removing the old manifestations preserves the full production proof suite.
