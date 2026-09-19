# Conflicting-effect ordering

## Question
Must incompatible effects on one canonical provider coordinate be ordered before they enter authority?

## Claim and contrast
Unordered incompatible GitHub status effects are rejected at admission. Explicitly ordered effects may execute and settle sequentially. The control is provider last-write-wins racing.

## Hostile cases
The deterministic suite covers incompatible unordered writes, case-only context aliases, amendments that remove ordering, explicit order, and identical desired writes. The hosted proof writes success, settles alpha, then writes failure and settles beta.

Current truth is deliberately not “both DONE”: beta changes the same mutable coordinate, so alpha's historical success is no longer currently admissible. Final verification must distinguish historical settlement from current realization truth.

## Run
```sh
npm run test:effect-order
gh workflow run conflicting-effect.yml
```

## Evidence
Main run `35463403321` falsified the obsolete final assertion that both mutable postconditions remain currently DONE. The corrected complete proof passed at exact revision `570e776aadb131589c9a47309d923e06b476e436` in run `35465653746`.

## Interpretation and non-claims
Ordering constrains mutation legality; current-realization admissibility is separate. This does not prove coordinate-scoped GitHub credentials or identical provider histories.
