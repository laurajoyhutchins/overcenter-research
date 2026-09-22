#!/usr/bin/env python3
"""Fail-closed exact-base admission for the independent Pylint holdout."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
CORPUS = HERE / "corpus.json"
GRAPH = REPO_ROOT / "experiments/code-graph-verification/frontier.py"


def run(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args, cwd=cwd, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False
    )


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def patch_paths(path: Path) -> list[str]:
    return [
        line[6:] for line in path.read_text(encoding="utf-8").splitlines()
        if line.startswith("+++ b/")
    ]


def blob_sha(path: str) -> str:
    result = run(["git", "-C", str(REPO_ROOT), "hash-object", path])
    if result.returncode != 0:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def exact(worktree: Path, patch: Path) -> dict:
    result = run(["git", "apply", "--check", str(patch)], cwd=worktree)
    return {"ok": result.returncode == 0, "stderr": result.stderr.strip()}


def discover_tests(
    worktree: Path,
    source_roots: list[str],
    test_roots: list[str],
    scratch: Path,
) -> dict:
    empty = scratch / "empty.patch"
    empty.write_text("", encoding="utf-8")
    args = [
        "python3", str(GRAPH), "predict",
        "--repo", str(worktree),
        "--patch", str(empty),
    ]
    for root in source_roots:
        args.extend(["--source-root", root])
    for root in test_roots:
        args.extend(["--test-root", root])
    result = run(args)
    if result.returncode != 0:
        return {"ok": False, "tests": 0, "stderr": result.stderr.strip()}
    report = json.loads(result.stdout)
    tests = int(report["metrics"]["tests"])
    return {
        "ok": tests > 0,
        "tests": tests,
        "base_parse_errors": report["metrics"]["base_parse_errors"],
        "stderr": "",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pylint-repo", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--require-admission", action="store_true")
    args = parser.parse_args()

    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    rep = corpus["representation"]
    observed_frontier = blob_sha(rep["frontier_path"])
    observed_score = blob_sha(rep["score_path"])
    representation_frozen = (
        observed_frontier == rep["frontier_git_blob_sha"]
        and observed_score == rep["score_git_blob_sha"]
    )

    repo = args.pylint_repo.resolve()
    results = []
    with tempfile.TemporaryDirectory(prefix="code-graph-pylint-preflight-") as tmp:
        root = Path(tmp)
        for index, case in enumerate(corpus["cases"]):
            worktree = root / f"case-{index}"
            add = run([
                "git", "-C", str(repo), "worktree", "add", "--detach",
                str(worktree), case["base_commit"]
            ])
            case_result = {
                "id": case["id"],
                "base_commit": case["base_commit"],
                "base_available": add.returncode == 0,
                "test_discovery": None,
                "variants": [],
            }
            if add.returncode != 0:
                case_result["base_error"] = add.stderr.strip()
                results.append(case_result)
                continue

            try:
                discovery = discover_tests(
                    worktree,
                    rep["source_roots"],
                    rep["test_roots"],
                    root,
                )
                case_result["test_discovery"] = discovery

                test_patch = (HERE / case["test_patch"]).resolve()
                test_check = exact(worktree, test_patch)
                case_result["test_patch"] = {
                    "path": case["test_patch"],
                    "sha256": digest(test_patch),
                    **test_check,
                }
                if test_check["ok"]:
                    applied = run(["git", "apply", str(test_patch)], cwd=worktree)
                    if applied.returncode != 0:
                        case_result["test_patch"]["ok"] = False
                        case_result["test_patch"]["stderr"] = applied.stderr.strip()

                for variant in case["variants"]:
                    patch = (HERE / variant["patch"]).resolve()
                    paths = patch_paths(patch)
                    touches_tests = any(
                        p == "tests" or p.startswith("tests/")
                        or p.startswith("test_") or "/tests/" in p
                        for p in paths
                    )
                    check = (
                        exact(worktree, patch)
                        if case_result["test_patch"]["ok"]
                        and discovery["ok"]
                        and not touches_tests
                        else {"ok": False, "stderr": ""}
                    )
                    reason = None
                    if not discovery["ok"]:
                        reason = "frozen graph discovered zero tests at declared base"
                    elif touches_tests:
                        reason = "candidate patch modifies held-out test namespace"
                    elif not case_result["test_patch"]["ok"]:
                        reason = "held-out test patch failed exact application"
                    elif not check["ok"]:
                        reason = "candidate patch failed exact git apply --check"

                    case_result["variants"].append({
                        "id": variant["id"],
                        "authorship": variant["authorship"],
                        "path": variant["patch"],
                        "sha256": digest(patch),
                        "paths": paths,
                        "admitted": reason is None,
                        "exclusion_reason": reason,
                        "stderr": check["stderr"],
                    })
            finally:
                run([
                    "git", "-C", str(repo), "worktree", "remove",
                    "--force", str(worktree)
                ])
            results.append(case_result)

    admitted = [
        (case["id"], variant)
        for case in results
        for variant in case["variants"]
        if variant["admitted"]
    ]
    human = [v for _, v in admitted if v["authorship"] == "human"]
    ai = [v for _, v in admitted if v["authorship"] == "ai"]
    discovered = [
        c for c in results
        if c.get("test_discovery", {}).get("ok")
    ]

    source_cases = {case["id"]: case for case in corpus["cases"]}
    nonidentical = 0
    for case_id, variant in admitted:
        if variant["authorship"] != "ai":
            continue
        gold = next(
            v for v in source_cases[case_id]["variants"]
            if v["authorship"] == "human"
        )
        if digest((HERE / gold["patch"]).resolve()) != variant["sha256"]:
            nonidentical += 1

    required = corpus["execution_admission"]
    counts = {
        "cases": len(results),
        "human_exact_apply": len(human),
        "ai_exact_apply": len(ai),
        "ai_nonidentical_to_human_exact_apply": nonidentical,
        "cases_with_nonzero_discovered_tests": len(discovered),
    }
    admission = (
        representation_frozen
        and counts["cases"] == required["cases"]
        and counts["human_exact_apply"] == required["human_exact_patches"]
        and counts["ai_exact_apply"] == required["ai_exact_patches"]
        and counts["ai_nonidentical_to_human_exact_apply"]
            == required["ai_nonidentical_to_human_exact_patches"]
        and counts["cases_with_nonzero_discovered_tests"]
            == required["cases_with_nonzero_discovered_tests"]
    )

    report = {
        "schema": "overcenter-code-graph-holdout-preflight/v1",
        "corpus_sha256": hashlib.sha256(CORPUS.read_bytes()).hexdigest(),
        "representation": {
            "frontier_expected": rep["frontier_git_blob_sha"],
            "frontier_observed": observed_frontier,
            "score_expected": rep["score_git_blob_sha"],
            "score_observed": observed_score,
            "frozen": representation_frozen,
        },
        "counts": counts,
        "execution_admission": admission,
        "cases": results,
    }
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.write_text(payload, encoding="utf-8")
    print(payload, end="")
    if args.require_admission and not admission:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
