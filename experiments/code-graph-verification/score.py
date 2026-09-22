#!/usr/bin/env python3
"""Score a predicted verification frontier against two pytest JUnit reports."""
from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path


def normalize(test_id: str) -> str:
    return re.sub(r"\[.*\]$", "", test_id)


def junit_statuses(path: Path) -> dict[str, str]:
    root = ET.parse(path).getroot()
    out: dict[str, str] = {}
    for tc in root.iter("testcase"):
        classname = tc.attrib.get("classname", "")
        name = tc.attrib.get("name", "")
        if not name:
            continue

        parts = classname.split(".") if classname else []
        file_parts: list[str] = []
        qual_parts: list[str] = []
        for part in parts:
            if qual_parts or (part and part[:1].isupper()):
                qual_parts.append(part)
            else:
                file_parts.append(part)

        file_path = "/".join(file_parts) + ".py" if file_parts else "<unknown>.py"
        qual = "::".join([*qual_parts, name])
        test_id = f"{file_path}::{qual}"

        if tc.find("failure") is not None:
            status = "fail"
        elif tc.find("error") is not None:
            status = "error"
        elif tc.find("skipped") is not None:
            status = "skip"
        else:
            status = "pass"
        out[normalize(test_id)] = status
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frontier", type=Path, required=True)
    parser.add_argument("--base-junit", type=Path, required=True)
    parser.add_argument("--patched-junit", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    frontier = json.loads(args.frontier.read_text(encoding="utf-8"))
    predicted = {normalize(x) for x in frontier["selected_tests"]}
    base = junit_statuses(args.base_junit)
    patched = junit_statuses(args.patched_junit)

    universe = set(base) | set(patched)
    affected = {
        test
        for test in universe
        if base.get(test, "missing") != patched.get(test, "missing")
    }
    regressions = {
        test
        for test in universe
        if base.get(test) == "pass" and patched.get(test) not in {"pass", "skip"}
    }
    caught = predicted & affected
    missed = affected - predicted
    missed_regressions = regressions - predicted
    selected_in_universe = predicted & universe

    result = {
        "schema": "overcenter-code-graph-verification-score/v1",
        "counts": {
            "universe": len(universe),
            "affected": len(affected),
            "regressions": len(regressions),
            "predicted": len(selected_in_universe),
            "caught": len(caught),
            "missed": len(missed),
            "missed_regressions": len(missed_regressions),
        },
        "metrics": {
            "recall": len(caught) / len(affected) if affected else 1.0,
            "precision": (
                len(caught) / len(selected_in_universe)
                if selected_in_universe
                else (1.0 if not affected else 0.0)
            ),
            "selected_fraction": (
                len(selected_in_universe) / len(universe) if universe else 0.0
            ),
            "reduction": (
                1.0 - len(selected_in_universe) / len(universe)
                if universe
                else 1.0
            ),
        },
        "affected": sorted(affected),
        "regressions": sorted(regressions),
        "missed": sorted(missed),
        "missed_regressions": sorted(missed_regressions),
    }
    payload = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.write_text(payload, encoding="utf-8")
    print(payload, end="")


if __name__ == "__main__":
    main()
