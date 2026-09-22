#!/usr/bin/env python3
"""Replay frontier prediction against preserved oracle evidence."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent


def run(
    args: list[str],
    *,
    cwd: Path | None = None,
    stdout=None,
) -> None:
    subprocess.run(args, cwd=cwd, check=True, text=True, stdout=stdout)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--flask-repo", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    args = parser.parse_args()

    repo = args.flask_repo.resolve()
    results = args.results.resolve()
    corpus = json.loads((HERE / "corpus.json").read_text(encoding="utf-8"))

    replayed = 0
    with tempfile.TemporaryDirectory(prefix="code-graph-frontier-replay-") as tmp:
        scratch = Path(tmp)

        for case_index, case in enumerate(corpus["cases"]):
            case_dir = results / case["id"]
            if not case_dir.exists():
                raise SystemExit(f"missing case evidence: {case_dir}")

            base = scratch / f"base-{case_index}"
            run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "worktree",
                    "add",
                    "--detach",
                    str(base),
                    case["base_commit"],
                ]
            )
            try:
                test_patch = (HERE / case["test_patch"]).resolve()
                run(["git", "apply", str(test_patch)], cwd=base)

                for variant_index, variant in enumerate(case["variants"]):
                    variant_dir = case_dir / variant["id"]
                    required = [
                        variant_dir / "run.json",
                        variant_dir / "base.xml",
                        variant_dir / "patched.xml",
                    ]
                    missing = [path.name for path in required if not path.exists()]
                    if missing:
                        raise SystemExit(
                            f"incomplete oracle evidence at {variant_dir}: "
                            f"missing={missing}"
                        )

                    patched = scratch / f"patched-{case_index}-{variant_index}"
                    run(
                        [
                            "git",
                            "-C",
                            str(repo),
                            "worktree",
                            "add",
                            "--detach",
                            str(patched),
                            case["base_commit"],
                        ]
                    )
                    try:
                        run(["git", "apply", str(test_patch)], cwd=patched)
                        candidate = (HERE / variant["patch"]).resolve()
                        run(["git", "apply", str(candidate)], cwd=patched)

                        frontier = variant_dir / "frontier.json"
                        with frontier.open("w", encoding="utf-8") as handle:
                            run(
                                [
                                    sys.executable,
                                    str(HERE / "frontier.py"),
                                    "predict",
                                    "--repo",
                                    str(base),
                                    "--patched-repo",
                                    str(patched),
                                    "--patch",
                                    str(candidate),
                                    "--source-root",
                                    "src",
                                    "--test-root",
                                    "tests",
                                ],
                                stdout=handle,
                            )
                        replayed += 1
                    finally:
                        run(
                            [
                                "git",
                                "-C",
                                str(repo),
                                "worktree",
                                "remove",
                                "--force",
                                str(patched),
                            ]
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
                        str(base),
                    ]
                )

    print(f"replayed {replayed} frontiers against preserved oracle evidence")


if __name__ == "__main__":
    main()
