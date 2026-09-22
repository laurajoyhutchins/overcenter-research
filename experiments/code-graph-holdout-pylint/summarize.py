#!/usr/bin/env python3
from __future__ import annotations
import argparse,json
from pathlib import Path
HERE=Path(__file__).resolve().parent

def ratio(n,d,empty): return n/d if d else empty

def main():
    p=argparse.ArgumentParser(); p.add_argument("--results",type=Path,required=True); p.add_argument("--preflight",type=Path,required=True); p.add_argument("--out",type=Path); a=p.parse_args()
    corpus=json.loads((HERE/"corpus.json").read_text()); pre=json.loads(a.preflight.read_text())
    if not pre["execution_admission"]: raise SystemExit("preflight not admitted")
    expected={(c["id"],v["id"]) for c in corpus["cases"] for v in c["variants"]}
    runs={}
    for rp in sorted(a.results.rglob("run.json")):
        d=rp.parent; run=json.loads(rp.read_text()); key=(run["case"],run["variant"])
        if key in runs: raise SystemExit(f"duplicate {key}")
        if not (d/"score.json").exists() or not (d/"frontier.json").exists(): raise SystemExit(f"incomplete {d}")
        if not run.get("environment_id"): raise SystemExit(f"no environment {key}")
        runs[key]={"run":run,"score":json.loads((d/"score.json").read_text()),"frontier":json.loads((d/"frontier.json").read_text())}
    if set(runs)!=expected: raise SystemExit(f"result set mismatch missing={sorted(expected-set(runs))} extra={sorted(set(runs)-expected)}")
    keys=["universe","affected","regressions","predicted","caught","missed","missed_regressions"]
    totals={k:0 for k in keys}; strata={s:{k:0 for k in keys} for s in ["human","ai"]}; obs=[]
    for key in sorted(runs):
        art=runs[key]; counts=art["score"]["counts"]; auth=art["run"]["authorship"]
        for k in keys: totals[k]+=counts[k]; strata[auth][k]+=counts[k]
        obs.append({"case":key[0],"variant":key[1],"authorship":auth,"score":art["score"],"changed_symbols":art["frontier"]["changed_symbols"],"frontier_metrics":art["frontier"]["metrics"]})
    metrics={"recall":ratio(totals["caught"],totals["affected"],1.0),"precision":ratio(totals["caught"],totals["predicted"],1.0),"selected_fraction":ratio(totals["predicted"],totals["universe"],0.0),"reduction":1-ratio(totals["predicted"],totals["universe"],0.0)}
    t=corpus["primary_thresholds"]; gates={"recall":metrics["recall"]>=t["recall_min"],"selected_fraction":metrics["selected_fraction"]<=t["selected_fraction_max"],"missed_regressions":totals["missed_regressions"]<=t["missed_regressions_max"]}
    report={"schema":"overcenter-code-graph-holdout-summary/v1","independent_holdout":True,"corpus_sha256":pre["corpus_sha256"],"raw_runs":len(runs),"totals":totals,"metrics":metrics,"thresholds":t,"gates":gates,"hypothesis_survived":all(gates.values()),"strata":strata,"observations":obs}
    payload=json.dumps(report,indent=2,sort_keys=True)+"\n"
    if a.out: a.out.write_text(payload)
    print(payload,end="")
if __name__=="__main__": main()
