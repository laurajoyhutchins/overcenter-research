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

## Second falsification round: semantic shapes and freshness

The next experiment deliberately does not add broad endpoint support. It selects representative GitHub read shapes and asks whether the handwritten semantic layer remains small:

| Shape | GitHub operation | Projection |
| --- | --- | --- |
| stable subject identity | `repos/get` | numeric repository identity + mutable owner/name alias |
| mutable binding | `git/get-ref` | stable repository ID + ref -> object SHA snapshot |
| immutable singleton | `git/get-commit` | content-addressed commit/tree/parents fact |
| mutable entity | `pulls/get` | pull-request snapshot, not an internal PR state machine |
| paginated collection | `checks/list-for-ref` | positive page membership with non-authoritative absence |

### Observation provenance

A raw observation now binds:

```text
pinned OpenAPI schema SHA-256
API version
operation ID
observer identity
local observation time
exact materialized request coordinate
non-secret request headers + auth class
GitHub Date / ETag / Link / request ID
HTTP result
raw body
```

The bearer token is never persisted. Its presence is recorded only as an authorization class.

This fixes an important evidence boundary: a projected fact identifies not only what GitHub returned, but which contract, observer, request, and response metadata justify that interpretation.

The GitHub Actions observer identity is currently the exact workflow run/attempt identity. This does **not** prove the underlying GitHub App installation ID. Installation identity remains a separate authority problem rather than being invented from the token.

### Stable repository identity

Provider coordinates such as `owner/repo` are treated as aliases. The projected subject identity is GitHub's numeric repository ID plus node ID:

```text
github.repository(1354872053)
        named
laurajoyhutchins/overcenter-research
```

Downstream ref, commit, PR, and collection facts bind to the numeric repository ID. A rename therefore changes an observed alias rather than manufacturing a different repository subject.

The unit proof simulates two owner/name aliases resolving to the same numeric repository ID. The live proof confirms the current repository's numeric identity. It does not rename the live repository merely to demonstrate the property.

### Immutable vs mutable facts

The experiment now makes stability explicit.

A Git commit read by exact object ID becomes:

```text
stability = content-addressed
```

and can be reused as durable evidence after caches disappear.

A ref or pull request becomes:

```text
stability = mutable-snapshot
```

and cannot be resurrected from historical evidence as current project state.

That distinction feeds reconstruction directly:

```text
durable historical facts
    |-- repository identity
    |-- immutable commit objects
    |
fresh current authority
    |-- ref bindings
    |-- pull-request snapshots
    |
    v
reconstructed projection
```

The reconstruction test intentionally supplies an old durable ref observation and no fresh ref observation. The reconstructed projection contains the durable commit but **no current ref**. Supplying fresh authority restores the current ref binding.

This is stronger than choosing the newest stored timestamp. A recent historical observation is still historical.

### Pull requests without a PullRequestStateMachine

The pull-request semantics project only the fields currently needed by an obligation:

```text
repository_id
pull number + stable GitHub PR id
state
head SHA
base ref
base SHA
observed_at
```

The evaluator compares an obligation to that authoritative snapshot. No transition graph for OPEN -> MERGED -> CLOSED is introduced.

This is an explicit falsification criterion: if useful GitHub entities can remain authoritative snapshots, Overcenter does not need to mirror provider lifecycle machines.

### Pagination and difficult negative evidence

For `checks/list-for-ref`, a page can prove that a returned check run exists and has the returned state.

It cannot prove that an unseen check run does not exist:

```text
member returned on page
    -> positive fact

member absent from page
    -> INDETERMINATE
```

This remains true even after observing a terminal page. REST pagination is not a provider snapshot transaction; concurrent mutations and authorization visibility prevent the experiment from upgrading a completed page walk into authoritative global absence.

The page fact therefore carries:

```text
negative_evidence_authoritative = false
```

rather than making completeness an inference hidden in control flow.

The first pull-request live proof exposed this case directly. While the PR workflow's check was visibly running, an immediate `checks/list-for-ref` read against the synthetic PR merge SHA returned an empty collection. The experiment treats that as a successful observation of what GitHub exposed at that instant, but **not** as proof that no check existed. The live positive-membership proof therefore uses a stable coordinate with established checks, while the current-run coordinate remains a hostile visibility probe whose missing member evaluates `INDETERMINATE`.

### Conditional requests / 304

Conditional HTTP is modeled as a cross-cutting observation semantic.

A `304 Not Modified` does not create a new bodyless provider fact. It may revalidate a prior positive observation only when all of these identities agree:

```text
provider
API version
operation ID
OpenAPI schema digest
method + request coordinate
prior ETag
current If-None-Match
```

When those conditions hold, the prior representation is reusable at the new observation time with an explicit `revalidated_from` link.

This is useful because freshness can be refreshed cheaply without pretending that `304` itself contains the resource representation.

### Current semantic compression result

The handwritten semantics now cover five materially different GitHub shapes without adding GitHub resource knowledge to the Overcenter kernel:

```text
stable identity
immutable object
mutable binding
mutable entity snapshot
collection page
conditional revalidation
```

That is evidence for semantic compression, but not yet proof that the pattern scales across the entire API.

The next failure signal to watch is **semantic rule growth**, not endpoint count. If new endpoint families mostly instantiate these shapes, the boundary is holding. If each family requires a bespoke lifecycle model, completeness theory, or recovery machine, the experiment has merely relocated GitHub-specific complexity.

### Remaining hard boundary

Authentication provenance is intentionally incomplete.

GitHub documents the built-in `GITHUB_TOKEN` as a GitHub App installation access token minted for each workflow job:

- https://docs.github.com/en/actions/concepts/security/github_token

However, GitHub's REST endpoint that returns a repository's GitHub App installation (`GET /repos/{owner}/{repo}/installation`) requires authentication as the App with a JWT and explicitly does **not** accept a GitHub App installation access token:

- https://docs.github.com/en/rest/apps/apps#get-a-repository-installation-for-the-authenticated-app

Therefore the job credential cannot use that endpoint to self-attest the installation ID that minted it. The experiment records the exact GitHub Actions run/attempt and bearer-auth class, but it does not infer installation identity from repository context, token shape, or the GitHub Actions App ID.

Settlement-strength evidence that depends on installation-specific authority remains unproven unless an independently authoritative App/JWT surface supplies that identity.


## Third falsification round: identity overlap and marginal semantic cost

The next round deliberately added surfaces that should reuse already discovered semantic shapes rather than introduce new lifecycle models:

- `issues/get` as a second mutable-entity surface;
- `repos/list-commit-statuses-for-ref` as a second ref-scoped paginated collection;
- `actions/list-workflow-runs-for-repo` as a repository-scoped paginated collection.

The result is mixed and more precise than the earlier “small handwritten semantics” hypothesis.

### Cross-surface identity is not REST `id`

PR #19 exposes the same logical pull request through two GitHub REST families.

The live proof observed:

```text
Pulls surface
  number   = 19
  id       = 4571454605
  node_id  = PR_kwDOUMG09c8AAAABEHrcjQ

Issues surface
  number   = 19
  id       = 5502784281
  node_id  = PR_kwDOUMG09c8AAAABEHrcjQ
```

The numeric REST IDs differ, while the GraphQL node ID is identical.

Therefore a provider-wide entity identity rule such as:

```text
GitHub entity identity = REST id
```

is false.

For entities exposed through multiple GitHub API families, the experiment now treats:

```text
(repository_id, node_id)
```

as the cross-surface entity key and keeps each REST numeric ID as a surface-specific alias.

This also exposed a reconstruction bug. Both Pull and Issue observations had outer fact kind `entity-snapshot`. Reconstruction originally branched only on that outer kind, so an Issue snapshot could overwrite the `pull_requests` materialization while tests still passed an existence check.

The reconstruction code now discriminates the typed subject and materializes:

```text
pull_requests[repository:number] -> Pull surface snapshot
issues[repository:number]        -> Issue surface snapshot

entities[repository:node_id]
  .pull_request -> Pull surface snapshot
  .issue        -> Issue surface snapshot
```

This is an example of why “generic fact kind” is not enough. Stable subject identity must survive provider surface aliasing without erasing the provenance of the surface that supplied each field.

### Collection semantics do reuse

Checks, commit statuses, and workflow runs all share the same epistemic rule:

```text
returned member
    -> positive evidence

unseen member
    -> INDETERMINATE
```

They now use one positive-membership evaluator and one pagination rule.

The collection subject itself remains typed:

```text
Check runs
  { repository_id, ref }

Commit statuses
  { repository_id, ref }

Workflow runs
  { repository_id }
```

The collection abstraction was changed from “ref collection” to a generic typed collection subject specifically because workflow runs falsified the assumption that every useful collection is ref-scoped.

This is a successful compression of the epistemic rule without erasing coordinate differences.

### But response decoding remains expensive

The handwritten runtime is now approximately:

```text
semantics.ts          801 lines
semantic-shapes.ts    125 lines
                     ----------
total                 926 lines
```

That is not a tiny semantic layer.

The growth is not primarily caused by pagination or obligation evaluation anymore. Those mechanics are shared. Most remaining growth comes from provider-specific response interpretation:

- which response fields establish identity;
- which fields are required to prove a useful proposition;
- validation of IDs, SHAs, enums, timestamps, and nullable values;
- endpoint-specific response envelopes;
- mapping API-specific aliases onto stable subjects.

The stronger conclusion is therefore:

> GitHub's **epistemic semantics** compress into a small number of reusable rules. GitHub's **response interpretation** does not automatically compress merely because OpenAPI describes the response schema.

This distinction matters architecturally.

OpenAPI can generate legal questions and structural decoders. A small handwritten layer can still decide which decoded fields are semantically meaningful. But if Overcenter hand-writes full response validation for every endpoint, the adapter will still grow roughly with the number of resource families.

### Revised success criterion

The experiment should no longer use total endpoint coverage or even raw semantic LOC as its primary success metric.

The useful split is:

```text
generated
  legal operations
  parameters
  wire request
  response structural decoding

handwritten
  stable identity choice
  semantic field selection
  evidence strength
  freshness class
  obligation predicate
```

The next architectural pressure should therefore be on generating more of the **structural response decoding** from the pinned OpenAPI schema while keeping the handwritten semantic choices explicit and typed.

That would test whether the current 926-line runtime can shrink for the right reason, rather than by moving semantics into an untyped configuration DSL.
