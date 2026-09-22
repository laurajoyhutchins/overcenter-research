#!/usr/bin/env python3
"""Fail-closed admission for the independent Pylint code-graph holdout."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

HERE=Path(__file__).resolve().parent
REPO_ROOT=HERE.parent.parent
GRAPH=REPO_ROOT/"experiments/code-graph-verification/frontier.py"
CORPUS=HERE/"corpus.json"


def run(args:list[str],cwd:Path|None=None)->subprocess.CompletedProcess[str]:
    return subprocess.run(args,cwd=cwd,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False)


def digest(path:Path)->str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def blob_sha(path:str)->str:
    r=run(["git","-C",str(REPO_ROOT),"hash-object",path])
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def patch_paths(path:Path)->list[str]:
    return [line[6:] for line in path.read_text().splitlines() if line.startswith("+++ b/")]


def exact(worktree:Path,patch:Path)->dict:
    r=run(["git","apply","--check",str(patch)],cwd=worktree)
    return {"ok":r.returncode==0,"stderr":r.stderr.strip()}


def graph_test_nodes(worktree:Path,source_roots:list[str],test_roots:list[str],scratch:Path)->dict:
    scratch.mkdir(parents=True,exist_ok=True)
    empty=scratch/"empty.patch"
    empty.write_text("",encoding="utf-8")
    cmd=["python3",str(GRAPH),"predict","--repo",str(worktree),"--patch",str(empty)]
    for root in source_roots:
        cmd.extend(["--source-root",root])
    for root in test_roots:
        cmd.extend(["--test-root",root])
    r=run(cmd)
    if r.returncode:
        return {"ok":False,"tests":0,"stderr":r.stderr.strip()}
    report=json.loads(r.stdout)
    return {
        "ok":report["metrics"]["tests"]>0,
        "tests":report["metrics"]["tests"],
        "base_parse_errors":report["metrics"]["base_parse_errors"],
        "stderr":""
    }


def main()->None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--pylint-repo",type=Path,required=True)
    parser.add_argument("--out",type=Path)
    parser.add_argument("--require-admission",action="store_true")
    args=parser.parse_args()

    corpus=json.loads(CORPUS.read_text())
    rep=corpus["representation"]
    representation={
        "frontier_expected":rep["frontier_git_blob_sha"],
        "frontier_observed":blob_sha(rep["frontier_path"]),
        "score_expected":rep["score_git_blob_sha"],
        "score_observed":blob_sha(rep["score_path"])
    }
    representation["frozen"]=(
        representation["frontier_expected"]==representation["frontier_observed"]
        and representation["score_expected"]==representation["score_observed"]
    )

    repo=args.pylint_repo.resolve()
    results=[]
    with tempfile.TemporaryDirectory(prefix="pylint-holdout-preflight-") as tmp:
        root=Path(tmp)
        for index,case in enumerate(corpus["cases"]):
            wt=root/f"case-{index}"
            add=run(["git","-C",str(repo),"worktree","add","--detach",str(wt),case["base_commit"]])
            cr={"id":case["id"],"base_commit":case["base_commit"],"base_available":add.returncode==0,"variants":[]}
            if add.returncode:
                cr["base_error"]=add.stderr.strip()
                results.append(cr)
                continue
            try:
                test_patch=(HERE/case["test_patch"]).resolve()
                tc=exact(wt,test_patch)
                cr["test_patch"]={"path":case["test_patch"],"sha256":digest(test_patch),**tc}
                if tc["ok"]:
                    applied=run(["git","apply",str(test_patch)],cwd=wt)
                    if applied.returncode:
                        cr["test_patch"]["ok"]=False
                        cr["test_patch"]["stderr"]=applied.stderr.strip()

                cr["graph_visibility"]=graph_test_nodes(
                    wt,rep["source_roots"],rep["test_roots"],root/f"graph-{index}"
                ) if cr["test_patch"]["ok"] else {"ok":False,"tests":0,"stderr":"test patch not admitted"}

                for variant in case["variants"]:
                    patch=(HERE/variant["patch"]).resolve()
                    paths=patch_paths(patch)
                    touches_tests=any(p=="tests" or p.startswith("tests/") for p in paths)
                    check=exact(wt,patch) if cr["test_patch"]["ok"] and not touches_tests else {"ok":False,"stderr":""}
                    reason=None
                    if touches_tests:
                        reason="candidate patch modifies held-out test namespace"
                    elif not cr["test_patch"]["ok"]:
                        reason="held-out test patch failed exact application"
                    elif not cr["graph_visibility"]["ok"]:
                        reason="pinned graph exposes no test nodes for case"
                    elif not check["ok"]:
                        reason="candidate patch failed exact git apply --check"
                    cr["variants"].append({
                        "id":variant["id"],"authorship":variant["authorship"],
                        "path":variant["patch"],"sha256":digest(patch),"paths":paths,
                        "admitted":reason is None,"exclusion_reason":reason,"stderr":check["stderr"]
                    })
            finally:
                run(["git","-C",str(repo),"worktree","remove","--force",str(wt)])
            results.append(cr)

    admitted=[(c["id"],v) for c in results for v in c["variants"] if v["admitted"]]
    human=[v for _,v in admitted if v["authorship"]=="human"]
    ai=[v for _,v in admitted if v["authorship"]=="ai"]
    source={c["id"]:c for c in corpus["cases"]}
    nonidentical=0
    for cid,v in admitted:
        if v["authorship"]!="ai":
            continue
        gold=next(x for x in source[cid]["variants"] if x["authorship"]=="human")
        if v["sha256"]!=digest((HERE/gold["patch"]).resolve()):
            nonidentical+=1
    min_tests=min((c.get("graph_visibility") or {}).get("tests",0) for c in results)
    counts={
        "human_exact_apply":len(human),
        "ai_exact_apply":len(ai),
        "ai_nonidentical_to_human_exact_apply":nonidentical,
        "minimum_graph_test_nodes":min_tests
    }
    req=corpus["execution_admission"]
    admission=(
        representation["frozen"]
        and counts["human_exact_apply"]==req["human_exact_patches"]
        and counts["ai_exact_apply"]==req["ai_exact_patches"]
        and counts["ai_nonidentical_to_human_exact_apply"]==req["ai_nonidentical_to_human_exact_patches"]
        and counts["minimum_graph_test_nodes"]>=req["minimum_graph_test_nodes_per_case"]
    )
    report={
        "schema":"overcenter-code-graph-holdout-preflight/v1",
        "corpus_sha256":hashlib.sha256(CORPUS.read_bytes()).hexdigest(),
        "representation":representation,"counts":counts,
        "execution_admission":admission,"cases":results
    }
    payload=json.dumps(report,indent=2,sort_keys=True)+"\n"
    if args.out:
        args.out.write_text(payload)
    print(payload,end="")
    if args.require_admission and not admission:
        raise SystemExit(1)


if __name__=="__main__":
    main()
