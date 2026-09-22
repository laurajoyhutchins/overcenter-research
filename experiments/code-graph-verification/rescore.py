#!/usr/bin/env python3
"""Recompute score.json files from immutable frontier and JUnit artifacts."""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", type=Path, required=True)
    args = parser.parse_args()

    runs = sorted(args.results.rglob("run.json"))
    if not runs:
        raise SystemExit("no run.json artifacts found")

    rescored = 0
    for run_json in runs:
        directory = run_json.parent
        frontier = directory / "frontier.json"
        base = directory / "base.xml"
        patched = directory / "patched.xml"
        score = directory / "score.json"
        missing = [
            str(path.name)
            for path in (frontier, base, patched)
            if not path.exists()
        ]
        if missing:
            raise SystemExit(
                f"incomplete evidence at {directory}: missing={missing}"
            )

        subprocess.run(
            [
                sys.executable,
                str(HERE / "score.py"),
                "--frontier",
                str(frontier),
                "--base-junit",
                str(base),
                "--patched-junit",
                str(patched),
                "--out",
                str(score),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        rescored += 1

    print(f"rescored {rescored} immutable variant artifacts")


if __name__ == "__main__":
    main()
