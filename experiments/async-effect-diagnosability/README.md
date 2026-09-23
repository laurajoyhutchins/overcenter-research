# Async effect diagnosability

## Question

Does the diagnosability tooling from `adapter-diagnosability` remain useful for an asynchronous provider effect where request acceptance and mutation completion are explicitly different events?

The real target is Overcenter's existing `github-pull-request/update-branch` effect.

## Independent boundary

This experiment freezes its expected boundary from sources that do not depend on the diagnoser:

1. GitHub documents `PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch` as returning HTTP `202 Accepted`, with the response message "Updating pull request branch."
2. RFC 9110 defines `202 Accepted` as accepted for processing but not completed, and explicitly permits the request to be acted upon later or never acted upon.
3. Current Overcenter production capabilities already forbid both replay and reservation release for `github-pull-request/update-branch`.
4. Current Overcenter observation can positively prove a completed update from exact PR identity plus ancestry of both the previous head and requested base.
5. An unchanged PR head currently reports `mutation_certainty: absent`, but it carries no accepted `AbsenceEvidenceCertificate`; therefore it is not authoritative terminal absence and cannot make replay safe.

References:

- GitHub REST API, "Update a pull request branch": https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch
- RFC 9110 §15.3.3, "202 Accepted": https://www.rfc-editor.org/rfc/rfc9110.html#name-202-accepted

No live provider mutation is performed by this experiment.

## Preregistered treatment

The production diagnoser is reused unchanged.

Two finite protocols differ in one liveness assumption.

### A. Bounded completion

After the observable `202 Accepted`, the provider eventually takes one unobservable transition:

```text
                  202 Accepted
                       |
                       v
                    pending
                   /       \
           applies           abandons
             |                  |
             v                  v
          occurred          not occurred
             |                  |
       UPDATE_PROVED        HEAD_UNCHANGED
```

A later authoritative readback therefore distinguishes the two worlds.

Expected result:

- ordinary diagnosability: **true**;
- safe diagnosability before `release-authority`: **false**;
- derived release decision: `ambiguous-do-not-release`;
- independent depth-12 trace oracle: zero surviving ambiguous observation sequences.

This tests the distinction between "eventually knowable" and "safe to act now."

### B. Unbounded pending

The second protocol adds one unobservable `provider-still-pending` self-loop to the pending state.

That is the conservative model when no completion bound is established for a `202 Accepted` operation.

Expected result:

- ordinary diagnosability: **false**;
- safe diagnosability: **false**;
- a concrete ambiguity-cycle witness exists;
- `release-authority` is exposed while ambiguous;
- the independent depth-12 oracle retains at least one ambiguous observation sequence;
- derived release decision: `ambiguous-do-not-release`.

## Post-observation model correction

The first hosted run of this real-adapter encoding exposed an experiment-modeling mistake: the protocol labeled both positive settlement (`settle-done`) and reservation release (`release-authority`) as generic consequential actions. The unchanged checker therefore returned a valid `settle-done` unsafe witness first, which did not answer this experiment's narrower question about safe authority reuse.

The correction removes only the `settle-done` consequential annotation. No state, transition, observation, bounded/unbounded liveness assumption, production cross-check, or diagnoser implementation changes. `release-authority` remains the sole consequential action because that is the preregistered safety property under test.

This correction is explicitly post-observation and is not counted as part of the original preregistration.

## Production cross-check

The experiment also reads the current production contracts without modifying them.

It must confirm:

- `github-pull-request/update-branch` replay capability is `forbidden`;
- reservation release capability is `forbidden`;
- an unchanged-head readback is not accepted as authoritative absence evidence;
- an ancestry-proven changed head verifies the postcondition.

These assertions keep the static model anchored to current runtime behavior while leaving runtime policy untouched.

## Falsification

The hypothesis is falsified if any of the following occurs without changing the analyzer:

1. the bounded-completion protocol is not ordinarily diagnosable;
2. the bounded-completion protocol is reported safe before `release-authority`;
3. the unbounded-pending protocol is reported diagnosable;
4. the unbounded protocol lacks an ambiguity-cycle witness;
5. the depth-12 oracle disagrees with the product checker;
6. current production capabilities permit replay or reservation release for this effect;
7. an unchanged-head observation produces accepted authoritative absence evidence;
8. ancestry-proven completion fails production verification.

## Reproduce

```sh
npm run test:async-effect-diagnosability
```

The experiment is deterministic. It requires no network, provider credential, database, model, or external solver.

## Interpretation

A positive result would show that the tooling can express an asynchronous effect without treating transport acceptance as mutation completion. More importantly, it would make the liveness assumption visible: the same protocol is eventually diagnosable under bounded completion and non-diagnosable when pending may persist indefinitely.

That is useful adapter-development feedback. It tells an adapter author exactly which additional provider guarantee or observation would be required before a consequential recovery action could be justified.

## Non-claims

This experiment does not establish that:

- GitHub's update-branch job actually remains pending forever in any real execution;
- HTTP `202` alone fully specifies GitHub's internal state machine;
- an unchanged head proves the update request was never accepted or will never execute;
- the finite protocol description is automatically a sound abstraction of the provider;
- diagnosability tooling should mint runtime authority or participate in settlement;
- the update-branch effect is promoted into Overcenter's supported production mutation slice.
