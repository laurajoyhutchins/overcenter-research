#!/usr/bin/env python3
"""Aggregate Requests holdout evidence against the frozen preregistered gates."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent


def ratio(n:int,d:int,empty:float)->float:
    return n/d if d else empty


def main()->None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--results",type=Path,required=True)
    parser.add_argument("--preflight",type=Path,required=True)
    parser.add_argument("--out",type=Path)
    args=parser.parse_args()

    corpus=json.loads((HERE/"corpus.json").read_text())
    preflight=json.loads(args.preflight.read_text())
    if preflight["schema"]!="overcenter-code-graph-holdout-preflight/v1":
        raise SystemExit("unexpected preflight schema")
    if not preflight["execution_admission"]:
        raise SystemExit("holdout preflight was not admitted")

    expected={
        (case["id"],variant["id"])
        for case in corpus["cases"]
        for variant in case["variants"]
    }
    runs={}
    for run_path in sorted(args.results.rglob("run.json")):
        d=run_path.parent
        run=json.loads(run_path.read_text())
        key=(run["case"],run["variant"])
        if key in runs:
            raise SystemExit(f"duplicate run {key}")
        score_path=d/"score.json"
        frontier_path=d/"frontier.json"
        if not score_path.exists() or not frontier_path.exists():
            raise SystemExit(f"incomplete evidence {d}")
        if not run.get("environment_id"):
            raise SystemExit(f"missing immutable environment for {key}")
        runs[key]={
            "run":run,
            "score":json.loads(score_path.read_text()),
            "frontier":json.loads(frontier_path.read_text())
        }

    if set(runs)!=expected:
        raise SystemExit(
            f"result set mismatch missing={sorted(expected-set(runs))} "
            f"extra={sorted(set(runs)-expected)}"
        )

    totals={k:0 for k in [
        "universe","affected","regressions","predicted","caught","missed","missed_regressions"
    ]}
    strata={"human":{k:0 for k in totals},"ai":{k:0 for k in totals}}
    observations=[]
    for key in sorted(runs):
        artifact=runs[key]
        counts=artifact["score"]["counts"]
        for k in totals:
            totals[k]+=counts[k]
            strata[artifact["run"]["authorship"]][k]+=counts[k]
        observations.append({
            "case":key[0],"variant":key[1],
            "authorship":artifact["run"]["authorship"],
            "score":artifact["score"],
            "changed_symbols":artifact["frontier"]["changed_symbols"],
            "frontier_metrics":artifact["frontier"]["metrics"]
        })

    metrics={
        "recall":ratio(totals["caught"],totals["affected"],1.0),
        "precision":ratio(totals["caught"],totals["predicted"],1.0),
        "selected_fraction":ratio(totals["predicted"],totals["universe"],0.0),
        "reduction":1-ratio(totals["predicted"],totals["universe"],0.0)
    }
    thresholds=corpus["primary_thresholds"]
    gates={
        "recall":metrics["recall"]>=thresholds["recall_min"],
        "selected_fraction":metrics["selected_fraction"]<=thresholds["selected_fraction_max"],
        "missed_regressions":totals["missed_regressions"]<=thresholds["missed_regressions_max"]
    }
    report={
        "schema":"overcenter-code-graph-holdout-summary/v1",
        "independent_holdout":True,
        "corpus_sha256":preflight["corpus_sha256"],
        "raw_runs":len(runs),
        "totals":totals,"metrics":metrics,"thresholds":thresholds,"gates":gates,
        "hypothesis_survived":all(gates.values()),
        "strata":strata,"observations":observations
    }
    payload=json.dumps(report,indent=2,sort_keys=True)+"\n"
    if args.out:
        args.out.write_text(payload)
    print(payload,end="")


if __name__=="__main__":
    main()
