# Eventually-consistent readback

## Question
May stale or negative eventually-consistent readback authorize replay after an uncertain mutation?

## Claim and contrast
No. Non-authoritative negative/non-matching reads remain recovery-bound. The control treats any negative read as permission to retry.

## Hostile cases
One accepted effect is followed by a negative read and a stale read; both must remain `RECOVERY_REQUIRED`, expose no READY work, and mint no absence authority. A later matching read may settle DONE. Effect attempts must remain exactly one.

## Run
```sh
npm run test:eventual
```

## Evidence
Passed at `1f6ad04704b3ed594c58ad5a5759be5048c3843d` in run `35463403306`.

## Interpretation and non-claims
Replay permission depends on evidence strength, not absence-shaped output. No real-provider convergence bound is claimed.
