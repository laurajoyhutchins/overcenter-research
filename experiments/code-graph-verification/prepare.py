#!/usr/bin/env python3
"""Materialize exact Flask base/patched worktrees and compute the blind frontier."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent


def run(*args: str, cwd: Path | None = None):
    subprocess.run(args, cwd=cwd, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--flask-repo", type=Path, required=True, help="Local clone of pallets/flask"
    )
    parser.add_argument("--case", required=True)
    parser.add_argument("--variant", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    manifest = json.loads((HERE / "corpus.json").read_text(encoding="utf-8"))
    case = next((item for item in manifest["cases"] if item["id"] == args.case), None)
    if case is None:
        raise SystemExit(f"unknown case: {args.case}")
    variant = next(
        (item for item in case["variants"] if item["id"] == args.variant), None
    )
    if variant is None:
        raise SystemExit(f"unknown variant: {args.variant}")

    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    base = out / "base"
    patched = out / "patched"
    for path in (base, patched):
        if path.exists():
            raise SystemExit(f"refusing to overwrite {path}")

    repo = args.flask_repo.resolve()
    run(
        "git", "-C", str(repo), "worktree", "add", "--detach", str(base),
        case["base_commit"],
    )
    try:
        run(
            "git", "-C", str(repo), "worktree", "add", "--detach", str(patched),
            case["base_commit"],
        )
        try:
            test_patch = (HERE / case["test_patch"]).resolve()
            candidate_patch = (HERE / variant["patch"]).resolve()

            for worktree in (base, patched):
                run("git", "apply", "--check", str(test_patch), cwd=worktree)
                run("git", "apply", str(test_patch), cwd=worktree)

            run("git", "apply", "--check", str(candidate_patch), cwd=patched)
            run("git", "apply", str(candidate_patch), cwd=patched)

            frontier = out / "frontier.json"
            with frontier.open("w", encoding="utf-8") as handle:
                subprocess.run(
                    [
                        sys.executable, str(HERE / "frontier.py"), "predict",
                        "--repo", str(base), "--patch", str(candidate_patch),
                        "--source-root", "src", "--test-root", "tests",
                    ],
                    check=True, stdout=handle, text=True,
                )

            (out / "run.json").write_text(
                json.dumps(
                    {
                        "schema": "overcenter-code-graph-verification-run/v1",
                        "case": case["id"],
                        "variant": variant["id"],
                        "authorship": variant["authorship"],
                        "base_commit": case["base_commit"],
                        "base_worktree": str(base),
                        "patched_worktree": str(patched),
                        "frontier": str(frontier),
                    },
                    indent=2,
                    sort_keys=True,
                ) + "\n",
                encoding="utf-8",
            )
        except Exception:
            run(
                "git", "-C", str(repo), "worktree", "remove", "--force", str(patched)
            )
            raise
    except Exception:
        run("git", "-C", str(repo), "worktree", "remove", "--force", str(base))
        raise

    print(f"prepared {case['id']} / {variant['id']}")
    print(f"blind frontier: {out / 'frontier.json'}")
    print(
        "Run the same full pytest command in base/ and patched/, emit JUnit XML, "
        "then score with score.py."
    )


if __name__ == "__main__":
    main()
