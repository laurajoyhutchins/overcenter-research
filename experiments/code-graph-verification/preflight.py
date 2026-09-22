#!/usr/bin/env python3
"""Exact-base application preflight for the code-graph verification corpus."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent


def run(args: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def patch_paths(path: Path) -> list[str]:
    paths: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("+++ b/"):
            paths.append(line[6:])
    return paths


def patch_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exact_apply_check(worktree: Path, patch: Path) -> dict:
    result = run(["git", "apply", "--check", str(patch)], cwd=worktree)
    return {
        "ok": result.returncode == 0,
        "stderr": result.stderr.strip(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--flask-repo", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--require-admission", action="store_true")
    args = parser.parse_args()

    repo = args.flask_repo.resolve()
    corpus_path = HERE / "corpus.json"
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))

    git_version = run(["git", "--version"]).stdout.strip()
    results: list[dict] = []

    with tempfile.TemporaryDirectory(prefix="overcenter-code-graph-preflight-") as tmp:
        root = Path(tmp)

        for index, case in enumerate(corpus["cases"]):
            base = case["base_commit"]
            worktree = root / f"case-{index}"
            base_check = run(
                ["git", "-C", str(repo), "cat-file", "-e", f"{base}^{{commit}}"]
            )
            case_result = {
                "id": case["id"],
                "base_commit": base,
                "base_available": base_check.returncode == 0,
                "test_patch": None,
                "variants": [],
            }

            if base_check.returncode != 0:
                case_result["base_error"] = base_check.stderr.strip()
                results.append(case_result)
                continue

            add = run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "worktree",
                    "add",
                    "--detach",
                    str(worktree),
                    base,
                ]
            )
            if add.returncode != 0:
                case_result["worktree_error"] = add.stderr.strip()
                results.append(case_result)
                continue

            try:
                test_patch = (HERE / case["test_patch"]).resolve()
                test_check = exact_apply_check(worktree, test_patch)
                case_result["test_patch"] = {
                    "path": case["test_patch"],
                    "sha256": patch_digest(test_patch),
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
                        p == "tests" or p.startswith("tests/") for p in paths
                    )
                    check = (
                        exact_apply_check(worktree, patch)
                        if case_result["test_patch"]["ok"] and not touches_tests
                        else {"ok": False, "stderr": ""}
                    )
                    reason = None
                    if touches_tests:
                        reason = "candidate patch modifies held-out test namespace"
                    elif not case_result["test_patch"]["ok"]:
                        reason = "held-out test patch failed exact application"
                    elif not check["ok"]:
                        reason = "candidate patch failed exact git apply --check"

                    case_result["variants"].append(
                        {
                            "id": variant["id"],
                            "authorship": variant["authorship"],
                            "equivalence_group": variant["equivalence_group"],
                            "path": variant["patch"],
                            "sha256": patch_digest(patch),
                            "paths": paths,
                            "admitted": reason is None,
                            "exclusion_reason": reason,
                            "stderr": check["stderr"],
                            "evaluation": variant.get("evaluation"),
                        }
                    )
            finally:
                run(
                    [
                        "git",
                        "-C",
                        str(repo),
                        "worktree",
                        "remove",
                        "--force",
                        str(worktree),
                    ]
                )

            results.append(case_result)

    variants = [
        variant
        for case in results
        for variant in case["variants"]
        if variant["admitted"]
    ]
    human = [v for v in variants if v["authorship"] == "human"]
    ai = [v for v in variants if v["authorship"] == "ai"]
    unsuccessful_ai = [
        v
        for v in ai
        if v.get("evaluation", {}).get("state") == "unresolved"
        or v.get("evaluation", {}).get("pass_to_pass_failure", 0) > 0
    ]

    nonidentical_ai = 0
    by_case = {case["id"]: case for case in results}
    source_cases = {case["id"]: case for case in corpus["cases"]}
    for case_id, result_case in by_case.items():
        source_case = source_cases[case_id]
        gold = next(
            v for v in source_case["variants"] if v["authorship"] == "human"
        )
        gold_digest = patch_digest((HERE / gold["patch"]).resolve())
        for variant in result_case["variants"]:
            if (
                variant["admitted"]
                and variant["authorship"] == "ai"
                and variant["sha256"] != gold_digest
            ):
                nonidentical_ai += 1

    admission = corpus["confirmatory_admission"]
    counts = {
        "human_exact_apply": len(human),
        "ai_exact_apply": len(ai),
        "ai_nonidentical_to_human_exact_apply": nonidentical_ai,
        "ai_unsuccessful_or_regressive_exact_apply": len(unsuccessful_ai),
    }
    admitted = (
        counts["human_exact_apply"] >= admission["human_exact_patches_min"]
        and counts["ai_exact_apply"] >= admission["ai_exact_patches_min"]
        and counts["ai_nonidentical_to_human_exact_apply"]
        >= admission["ai_nonidentical_to_human_min"]
        and counts["ai_unsuccessful_or_regressive_exact_apply"]
        >= admission["ai_unsuccessful_or_regressive_exact_patches_min"]
    )

    report = {
        "schema": "overcenter-code-graph-verification-preflight/v1",
        "corpus_sha256": hashlib.sha256(corpus_path.read_bytes()).hexdigest(),
        "git_version": git_version,
        "counts": counts,
        "execution_admission": admitted,
        "cases": results,
    }
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.write_text(payload, encoding="utf-8")
    print(payload, end="")

    if args.require_admission and not admitted:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
