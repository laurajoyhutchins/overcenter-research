# GitHub observation grammar from OpenAPI

## Question

Can Overcenter turn messy GitHub state into authoritative observations without teaching the kernel a hand-written model of branches, pull requests, checks, workflows, and other GitHub resources?

## Result

Partly. GitHub's OpenAPI description can mechanically generate the **observation grammar**: which read operations exist, their coordinates, parameters, possible response statuses, response schemas, and GitHub-specific operation metadata.

It cannot mechanically generate all of the **observation semantics**: whether a negative response proves absence, whether a collection read is complete, which returned fields establish stable identity, whether a response is sufficiently current for settlement, or how one observation relates to another.

The useful boundary is therefore:

```text
GitHub OpenAPI
      |
      v
read-only observation descriptors        generated
      |
      v
raw authoritative observations
      |
      v
small provider semantics                  handwritten
      |
      v
facts
      |
      v
obligation predicates
```

The kernel does not need to know what a GitHub branch is. It needs a fact plus a predicate over that fact.

## Implemented proof

This experiment implements one slice:

```text
GET /repos/{owner}/{repo}/git/ref/{ref}
      |
      v
raw observation
      |
      v
Binding(
  github.ref(owner, repo, ref),
  "targets",
  github.commit(sha)
)
      |
      v
required_sha == observed_sha
      |
      +-- true  -> SATISFIED
      +-- false -> UNSATISFIED
```

`experiments/github-observation-grammar/openapi.ts` mechanically derives a read-only observation descriptor from an OpenAPI document and records the exact API version, operation ID, request coordinate, HTTP outcome, and raw value.

`experiments/github-observation-grammar/semantics.ts` is intentionally separate. It contains the handwritten rule that a successful `git/get-ref` response with a matching coordinate proves a `ref -> object SHA` binding.

## Negative evidence rule

This experiment deliberately refuses the tempting conversion:

```text
HTTP 404 -> does not exist
```

Instead:

```text
HTTP 404 -> not observed by this request
             -> obligation INDETERMINATE
```

A caller may later strengthen that result only if it has additional semantics proving that the observer had sufficient authority and that GitHub's response is strong enough to establish absence.

Likewise, a transport failure remains `INDETERMINATE`.

Redirects are evidence rather than transparent transport behavior. The concrete GitHub transport uses manual redirect handling; a 3xx remains `INDETERMINATE` and records its `Location` instead of silently attributing a downstream response to the original operation.

A successful positive read is stronger. If GitHub authoritatively returns that the requested ref targets SHA `B` while the obligation requires SHA `A`, the obligation is `UNSATISFIED`.

## What is generated vs handwritten

Generated from OpenAPI:

- method and path template
- operation ID
- path/query/header parameters
- materialized operation-specific request headers
- documented response statuses
- JSON response schemas when present
- `x-github` operation metadata
- an inventory containing only read operations (`GET` and `HEAD`)

Handwritten provider semantics:

- `git/get-ref` body shape sufficient to prove a binding
- canonical ref identity (`heads/main` vs `refs/heads/main`)
- SHA validation
- coordinate matching
- strength of negative evidence
- obligation evaluation

This is a deliberately small handwritten layer. If that layer grows into a second GitHub model, the experiment has failed.

## Safety properties exercised

The tests establish:

1. mutation operations are not admitted into the generated observation catalog;
2. a successful exact ref read can prove an exact-SHA obligation;
3. a successful mismatching ref read can prove that obligation unsatisfied;
4. `404` is not strengthened into proof of absence; and
5. transport failure cannot create a negative fact; and
6. declared header parameters are both recorded and sent, while undeclared parameters are rejected;
7. the concrete REST transport pins the API version and preserves raw provider response data; and
8. redirects are not followed implicitly and remain explicit indeterminate evidence.

## Measured full-schema and live-provider result

The branch now exercises the generic generator against GitHub's actual dereferenced REST description, pinned to:

- API version: `2026-03-10`
- `github/rest-api-description` source commit: `d4278c869e367f5d6d4e0f46878119128abba77b`
- schema: `descriptions/api.github.com/dereferenced/api.github.com.2026-03-10.deref.json`

Without endpoint-specific generator code, the catalog contains:

- 647 read operations, all `GET` in this schema
- 647 unique operation IDs
- 2,263 parameters
- 1,652 documented response outcomes
- 518 operations marked `enabledForGitHubApps`

The same CI run then used the descriptor generated for `git/get-ref` to read the branch hosting the experiment from GitHub's live REST API. The request used API version `2026-03-10`, received HTTP `200`, observed the exact branch ref and exact head commit, projected that response into a binding fact, and evaluated the exact-SHA obligation as:

```text
SATISFIED
AUTHORITATIVE_BINDING_MATCHES
```

For the proving head `0801afd149a101f294aa25219c3474f99cc1d9cd`, the live observation was:

```text
github.ref(
  laurajoyhutchins/overcenter-research,
  refs/heads/experiment/github-observation-grammar
)
  targets
github.commit(0801afd149a101f294aa25219c3474f99cc1d9cd)
```

This is the first end-to-end evidence that the split is viable:

```text
pinned OpenAPI
    -> generated legal question
    -> live authoritative provider read
    -> small handwritten projection
    -> fact
    -> obligation predicate
```

It does not establish that all 647 read operations have useful settlement semantics. It establishes that the mechanical vocabulary can be broad while provider semantics remain outside the generator and outside the kernel.

## What this does not prove

This is not yet a complete GitHub observer. In particular it does not establish:

- stable repository identity across owner/name renames;
- pagination completeness for collection endpoints;
- conditional request / `304` semantics;
- eventual-consistency bounds;
- webhook-to-readback relationships;
- authentication or GitHub App installation identity in evidence;
- settlement-strength rules for checks, statuses, workflows, pull requests, issues, or deployments;

## Next falsification step

Run the generator over GitHub's pinned `2026-03-10` OpenAPI description and measure how much of the read surface is admitted without handwritten endpoint knowledge. Then classify the handwritten semantic rules required for a small set of representative endpoint families:

- singleton immutable object: commit
- singleton mutable coordinate: Git ref
- mutable entity: pull request
- paginated collection: commit statuses or workflow runs
- difficult negative evidence: checks/statuses or another eventually consistent provider surface

The useful metric is not endpoint coverage by itself. It is how much GitHub state becomes safely observable while the handwritten semantic layer remains small and explicit.
