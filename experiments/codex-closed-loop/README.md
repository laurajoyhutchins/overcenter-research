# Codex closed-loop self-development proof

## Question

Can Overcenter claim one exact code-change obligation, hand the implementation judgment to a disposable Codex worker, independently verify and settle the candidate, and only then let trusted code publish the exact verified bytes to GitHub?

## Claim and contrast

This is a hosted mechanism witness. Trusted Overcenter authority creates and claims one obligation at the exact workflow source revision. The untrusted worker gets a read-only checkout with no persisted Git credentials and may modify only one controlled fixture. Codex runs through the official GitHub Action under an unprivileged account and the `:workspace` permission profile.

The worker cannot publish. It emits a patch plus candidate metadata. A fresh trusted job:

1. verifies the assignment and patch digests;
2. reconstructs the exact source revision;
3. rejects untracked files and any changed path except the declared target;
4. rejects target mode changes;
5. applies the candidate on a clean checkout;
6. independently checks the exact postcondition;
7. reopens Overcenter authority and settles the original run `DONE`.

Only after settlement does a separate job receive `contents: write` and `pull-requests: write`. It reapplies the exact verified patch, creates a commit, pushes a fresh branch, opens a draft PR, and a final read-only job checks that GitHub reports the expected base and exact head commit.

The contrast is a conventional agent workflow in which the reasoning worker holds repository mutation credentials or declares its own success.

## Run

Local contract:

```sh
npm run test:codex-closed-loop
```

Hosted proof, after this workflow is present on the default branch:

```sh
gh workflow run codex-closed-loop.yml
```

The repository must provide `OPENAI_API_KEY` as a GitHub Actions secret. The workflow uses an immutable pin of the current `openai/codex-action` v1 ref.

## Distinguishing criterion

A passing run must demonstrate all of the following in one workflow execution:

- exact Overcenter claim identity exists before Codex runs;
- the Codex job has no repository write or pull-request permission;
- the candidate is confined to the single declared file and bound to the assignment digest;
- trusted authority, not Codex, establishes the postcondition and settles the run;
- the publisher receives the exact patch digest that the verifier settled;
- GitHub readback reports a draft PR whose base is the claimed source revision and whose head is the trusted publisher's exact commit.

## Interpretation

A positive result establishes that the reasoning worker can be disposable while execution truth remains outside it. It is the smallest physical closed loop from claimed Overcenter work through uncertain implementation to independently verified GitHub reality.

The witness is intentionally trivial. It isolates the transaction boundary before substituting a real maintenance issue.

## Non-claims

This experiment does not show that arbitrary code changes can be verified safely, that the current witness should be merged, that Codex is trusted, that GitHub is project truth, or that provider mutation recovery is solved. It also does not yet prove ambiguous-outcome recovery if the branch push or PR creation succeeds but its response is lost.
