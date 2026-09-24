# Research-result obligation integration

> Historical evidence only. Evaluated at exact revision `49765f430199ba5445a78235afcdce575d76341d`. The production `ResearchResult` / `ResearchPlan` candidate that followed this experiment was later removed because it did not authenticate canonical exact-revision provider evidence. Reproduce the original treatment by checking out the evaluated revision.


## Question

Can exact, trusted experiment outcomes become semantic inputs to Overcenter source obligations so justified promotions become READY independently of pull-request topology?

## Preregistered treatment

The treatment is frozen before first hosted execution at base revision '693f67c29824376dd970d265fdb9d5e45b5a4e66'.

It models three research results:

- synthetic A: supported;
- synthetic B: falsified;
- the already-evaluated 'source-obligation-integration' result from the maintained experiment registry: supported.

A trusted evaluator signs a compact result payload containing the experiment identity, design digest, exact evaluated revision, outcome, claim digest, and evidence digest. Promotion compilation verifies that signature before using any result.

Semantic result identity deliberately excludes evaluation-run coordinates and evidence transport identity:

    experiment
    + design digest
    + outcome
    + claim digest
            ↓
    research-result semantic identity

A research plan then deterministically compiles only justified promotions into stable source-change work. Promotion semantic identity consumes research-result identities and upstream promotion semantic identities, but contains no PR number, branch name, or source base SHA.

Two independent justified promotions are claimed against the same old source revision, produce candidates independently, and are integrated against current source after one promotion and an unrelated source change have already moved 'main'. No candidate is restacked.

## Falsifiers

The experiment fails if any of the following occur:

1. changing a signed falsified result to 'supported' without the trusted evaluator key activates promotion work;
2. rerunning an unchanged experiment at a different exact revision or with different evidence coordinates changes semantic result identity or downstream promotion identity;
3. changing the established research meaning fails to invalidate the directly dependent promotion and its semantic descendant, or invalidates an unrelated promotion;
4. a falsified experiment materializes its planned promotion;
5. either independently produced source candidate must be rebuilt merely because unrelated current source moved;
6. deleting all simulated PR/projection metadata changes promotion semantic identity;
7. a candidate that conflicts with current source is blindly integrated instead of returning 'REREALIZE_REQUIRED'.

## Acceptance criteria

- the compiler materializes 'promotion-a', its semantic child, and the real-result 'promotion-c', but not 'promotion-b';
- forged supported outcome is rejected by certificate verification;
- semantically identical reruns produce the same result identity and the same promotion keys;
- changed research meaning changes exactly the dependent promotion keys in the bounded graph;
- two independently produced promotion candidates, both bound to the original source revision, integrate successfully after 'main' moves, preserving both promotions and the unrelated change;
- removal of projection metadata leaves the compiled graph byte-equivalent at the semantic-key surface;
- conflicting current source leaves the target ref unchanged and requires re-realization.

## Boundary

This is a deterministic composition experiment. It does not modify production project intent, scheduler admission, verified-generated-output settlement, GitHub PR publication, or remote ref mutation.

The signing key is ephemeral experiment machinery, not a proposed production key-custody design. The maintained registry is used only as input for one already-supported real result; the experiment does not make registry text authoritative. A production bridge still requires trusted result construction from exact-head evidence.

The positive result established the bounded semantic idea, not a production trust boundary. A future promotion path should use ordinary Git history plus canonical exact-revision provider evidence directly, with Overcenter only deciding whether that admitted evidence satisfies a source obligation.
