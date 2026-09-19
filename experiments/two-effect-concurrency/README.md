# Two-effect concurrency

## Question
Does serializing project-authority commits require globally serializing independent external effects?

## Claim and contrast
Independent obligations can remain EXECUTING simultaneously and settle through one CAS authority while retaining exact claim identity. The control globally serializes effects merely because authority serializes.

## Run
```sh
npm run test:concurrency
gh workflow run two-effect-concurrency.yml
```

## Evidence
At `1f6ad04704b3ed594c58ad5a5759be5048c3843d`, hosted run `35463403309` passed.

## Interpretation and non-claims
Authority serialization and effect concurrency are distinct. Same-coordinate compatibility and provider-history commutativity are separate claims.
