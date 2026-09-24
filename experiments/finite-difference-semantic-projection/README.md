# Finite-difference semantic projection

## Question

Can the finite-difference READY treatment extend through semantic-key propagation and current-realization validity while keeping provider observation as an explicit authority input, without hiding project-wide scans behind a small "touched" count?

This experiment is stacked on the READY finite-difference proof. Provider observation remains an explicit input. The treatment incrementally maintains the pure projection consequences of that observation.

## Review correction

The first treatment established semantic equivalence but overstated its locality result. It counted only nodes whose derived state was recomputed while `#propagate()` still scanned the complete topological order, READY selection rescanned and sorted all ready work, and node recomputation scanned historical runs for the obligation.

Those behaviors made the original "affected semantic closure" cost claim too strong.

The repaired treatment therefore instruments total examined work and removes those hidden global scans from the mutation path.

## Repaired treatment

For each obligation:

```text
semanticKey(o) =
  digest(
    o identity
    + packet
    + postcondition
    + identities selected by semantic dependency edges
  )

semantic dependency identity =
  null                                if upstream is not DONE
  verified content identity           for output/verified-content
  current settlement commit identity  for evidence/settlement-receipt

lifecycle(o) =
  DONE               if an exact-key historical DONE realization is currently admissible
  EXECUTING/WAITING/
  RECOVERY_REQUIRED  for the latest exact-key nonterminal run
  UNREALIZED         otherwise
```

Current-realization validity is not inferred from graph state. An explicit provider observation is classified by production `classifyCurrentRealization()`, and that judgment becomes an input delta.

The repaired incremental machinery maintains:

```text
semantic downstream index, selector-aware
run summary bucket by (obligation, semantic key)
READY membership set
indexed READY min-heap ordered by (serviceAge, id)
```

Propagation is change-driven:

```text
changed obligation
      ↓
recompute that node
      ↓
lifecycle changed?
  refresh direct dependency claimability

DONE realization changed?
  settlement-receipt consumers may change
  verified-content consumers do not change
      ↓
enqueue only semantic consumers whose consumed identity may change
      ↓
repeat until no derived identity changes
```

A mutation no longer scans the global topological order. Historical runs are summarized during reconstruction; a mutation looks up one current semantic-key bucket rather than rescanning every old run.

## Production oracle

After every hostile transition, the experimental projection must exactly match production `deriveProjectProjection()` for:

- semantic key;
- lifecycle status;
- selected historical run;
- claimability error;
- READY membership;
- replay-derived service-age READY selection.

The production oracle receives the same explicit current-realization judgments.

## Hostile corpus

The graph contains both semantic selectors:

```text
                    ┌─ verified-content ─► by-content ─► content-grandchild
root ───────────────┤
                    └─ settlement-receipt ► by-settlement ► settlement-grandchild

root ── control ─► control-child
```

The corpus exercises indeterminate observation, restored realization, authoritative contradiction, upstream resettlement, verified-content historical reuse, settlement-receipt invalidation, downstream resettlement, and current-realization rejection/revalidation.

## Negative control

A two-node settlement-receipt graph updates the root current-realization judgment but deliberately omits semantic-descendant propagation. Production recomputation must detect the stale consumer projection.

## Locality treatment

Graphs of 128, 512, 2,048, and 8,192 obligations contain one five-node settlement-receipt semantic chain plus unrelated padding.

The root observation alternates between admissible and indeterminate 40 times. Every mutation records:

```text
semantic_nodes_examined
dependency_edges_examined
history_buckets_examined
historical_runs_examined
ready_candidates_examined
```

Acceptance requires the semantic nodes examined to remain exactly five at every graph size, historical-run scans to remain zero, and READY-heap comparisons to stay within an explicit logarithmic bound. The selected READY result is included in the timed treatment.

## History-length treatment

A one-obligation fixture is populated with 1, 10, 100, and 1,000 exact-key historical DONE runs. Current realization alternates between rejected and admissible 40 times.

The incremental mutation must inspect exactly one semantic-key history bucket and zero individual historical runs regardless of history length. Full production recomputation remains the oracle and is intentionally allowed to scan its historical inputs.

## Reproduce

```sh
npm run experiment:finite-difference-semantic-projection
```

## Success criteria

1. Every hostile transition exactly matches production semantic keys, lifecycles, selected runs, claimability, READY membership, and READY selection.
2. Verified-content consumers retain their semantic identity and reusable realization across an upstream resettlement with unchanged desired content.
3. Settlement-receipt consumers acquire a new semantic identity and invalidate their historical realization after the upstream settlement commit changes.
4. Indeterminate current realization blocks reuse, while authoritative contradiction makes the exact semantic identity unrealized rather than silently DONE.
5. Omitting semantic-descendant propagation is detected by the production oracle.
6. At 128, 512, 2,048, and 8,192 obligations, a five-node semantic chain causes exactly five semantic nodes to be examined per root observation mutation.
7. READY selection uses the maintained indexed frontier and remains within the declared logarithmic comparison bound rather than rescanning all obligations.
8. At 1, 10, 100, and 1,000 historical runs, each current-realization mutation examines one history bucket and zero individual historical runs.
9. No production scheduler, projection, provider, storage, or authority code changes.

## Design provenance

The original semantic-equivalence treatment was preregistered. Review after its first successful run found three hidden costs: global topological scanning, global READY selection, and per-obligation history scanning. The repaired cost instrumentation and history-length treatment were added in response. This experiment is therefore recorded as mixed provenance rather than retroactively calling the repair preregistered.

## Non-claims

A positive result does not prove that live provider observation itself can be inferred; observations remain explicit authority inputs. It does not incrementalize static effect-conflict maintenance, graph-patch topology changes, every `ProjectExplanation` field, or arbitrary adapter semantics. Reconstruction still has whole-history/whole-graph cost. The full production recomputation oracle remains authoritative for the differential. Wall-clock ratios are secondary and host-specific.
