#!/usr/bin/env python3
"""Aggregate code-graph verification runs without manual selection or arithmetic."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent


def canonical_subset(score: dict, frontier: dict) -> str:
    return json.dumps(
        {
            "counts": score["counts"],
            "metrics": score["metrics"],
            "affected": score["affected"],
            "regressions": score["regressions"],
            "missed": score["missed"],
            "missed_regressions": score["missed_regressions"],
            "changed_symbols": frontier["changed_symbols"],
            "selected_tests": frontier["selected_tests"],
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def ratio(numerator: int, denominator: int, empty: float) -> float:
    return numerator / denominator if denominator else empty


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--preflight", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    corpus = json.loads((HERE / "corpus.json").read_text(encoding="utf-8"))
    cases = {case["id"]: case for case in corpus["cases"]}
    variants = {
        (case["id"], variant["id"]): variant
        for case in corpus["cases"]
        for variant in case["variants"]
    }

    expected: set[tuple[str, str]] | None = None
    preflight_digest = None
    if args.preflight:
        preflight = json.loads(args.preflight.read_text(encoding="utf-8"))
        if preflight["schema"] != "overcenter-code-graph-verification-preflight/v1":
            raise SystemExit("unexpected preflight schema")
        if not preflight["execution_admission"]:
            raise SystemExit("preflight did not satisfy confirmatory execution admission")
        expected = {
            (case["id"], variant["id"])
            for case in preflight["cases"]
            for variant in case["variants"]
            if variant["admitted"]
        }
        preflight_digest = preflight["corpus_sha256"]

    runs: dict[tuple[str, str], dict] = {}
    for run_path in sorted(args.results.rglob("run.json")):
        directory = run_path.parent
        score_path = directory / "score.json"
        frontier_path = directory / "frontier.json"
        if not score_path.exists() or not frontier_path.exists():
            raise SystemExit(f"incomplete run artifact set: {directory}")

        run = json.loads(run_path.read_text(encoding="utf-8"))
        key = (run["case"], run["variant"])
        if key in runs:
            raise SystemExit(f"duplicate run for {key}")
        if key not in variants:
            raise SystemExit(f"run not present in corpus: {key}")
        if run["base_commit"] != cases[key[0]]["base_commit"]:
            raise SystemExit(f"base revision mismatch for {key}")
        if args.preflight and not run.get("environment_id"):
            raise SystemExit(f"confirmatory run lacks immutable environment_id: {key}")

        score = json.loads(score_path.read_text(encoding="utf-8"))
        frontier = json.loads(frontier_path.read_text(encoding="utf-8"))
        runs[key] = {
            "run": run,
            "score": score,
            "frontier": frontier,
            "directory": str(directory),
        }

    observed = set(runs)
    if expected is not None:
        missing = sorted(expected - observed)
        extra = sorted(observed - expected)
        if missing or extra:
            raise SystemExit(
                "result set does not exactly match preflight admission: "
                f"missing={missing} extra={extra}"
            )

    groups: dict[tuple[str, str], list[tuple[tuple[str, str], dict]]] = {}
    for key, artifact in runs.items():
        variant = variants[key]
        group_key = (key[0], variant["equivalence_group"])
        groups.setdefault(group_key, []).append((key, artifact))

    representatives: list[dict] = []
    for group_key, members in sorted(groups.items()):
        fingerprints = {
            canonical_subset(item["score"], item["frontier"])
            for _, item in members
        }
        if len(fingerprints) != 1:
            raise SystemExit(
                "declared equivalence group produced different graph/outcome evidence: "
                f"{group_key}"
            )

        key, artifact = members[0]
        authorships = sorted({variants[k]["authorship"] for k, _ in members})
        representatives.append(
            {
                "case": group_key[0],
                "equivalence_group": group_key[1],
                "variants": [k[1] for k, _ in members],
                "authorships": authorships,
                "score": artifact["score"],
            }
        )

    totals = {
        "universe": 0,
        "affected": 0,
        "regressions": 0,
        "predicted": 0,
        "caught": 0,
        "missed": 0,
        "missed_regressions": 0,
    }
    for observation in representatives:
        counts = observation["score"]["counts"]
        for key in totals:
            totals[key] += counts[key]

    metrics = {
        "recall": ratio(totals["caught"], totals["affected"], 1.0),
        "precision": ratio(totals["caught"], totals["predicted"], 1.0),
        "selected_fraction": ratio(totals["predicted"], totals["universe"], 0.0),
        "reduction": 1.0 - ratio(totals["predicted"], totals["universe"], 0.0),
    }
    thresholds = corpus["primary_thresholds"]
    gates = {
        "recall": metrics["recall"] >= thresholds["recall_min"],
        "selected_fraction": (
            metrics["selected_fraction"] <= thresholds["selected_fraction_max"]
        ),
        "missed_regressions": (
            totals["missed_regressions"] <= thresholds["missed_regressions_max"]
        ),
    }

    report = {
        "schema": "overcenter-code-graph-verification-summary/v1",
        "confirmatory": args.preflight is not None,
        "preflight_corpus_sha256": preflight_digest,
        "raw_runs": len(runs),
        "effective_observations": len(representatives),
        "totals": totals,
        "metrics": metrics,
        "thresholds": thresholds,
        "gates": gates,
        "hypothesis_survived": all(gates.values()),
        "observations": representatives,
    }
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.write_text(payload, encoding="utf-8")
    print(payload, end="")


if __name__ == "__main__":
    main()
