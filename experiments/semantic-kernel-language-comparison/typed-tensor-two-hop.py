#!/usr/bin/env python3
"""Untrusted typed two-hop consumer for the Lean graph tensor experiment."""

from __future__ import annotations

import json
import sys
from typing import Any


SCHEMA = "overcenter-lean-graph-tensor/v1"
OUTPUT_SCHEMA = "overcenter-python-two-hop/v1"


def fail(message: str) -> None:
    raise SystemExit(message)


def matmul(left: list[list[int]], right: list[list[int]]) -> list[list[int]]:
    size = len(left)
    return [
        [
            sum(left[row][middle] * right[middle][column] for middle in range(size))
            for column in range(size)
        ]
        for row in range(size)
    ]


def main() -> int:
    payload: dict[str, Any] = json.load(sys.stdin)
    if payload.get("schema") != SCHEMA:
        fail("unexpected tensor schema")

    node_ids = payload.get("node_ids")
    relation_names = payload.get("relation_names")
    edge_index = payload.get("edge_index")
    edge_type = payload.get("edge_type")
    view_key = payload.get("view_key")

    if not isinstance(node_ids, list) or not all(isinstance(item, str) for item in node_ids):
        fail("node_ids must be strings")
    if not isinstance(relation_names, list) or not all(
        isinstance(item, str) for item in relation_names
    ):
        fail("relation_names must be strings")
    if not isinstance(edge_index, list) or not isinstance(edge_type, list):
        fail("edge arrays missing")
    if len(edge_index) != len(edge_type):
        fail("edge arrays differ in length")
    if not isinstance(view_key, str):
        fail("view_key missing")

    size = len(node_ids)
    planes = [
        [[0 for _ in range(size)] for _ in range(size)]
        for _ in relation_names
    ]

    for pair, relation in zip(edge_index, edge_type, strict=True):
        if (
            not isinstance(pair, list)
            or len(pair) != 2
            or not all(isinstance(value, int) for value in pair)
        ):
            fail("invalid edge index")
        source, target = pair
        if source < 0 or source >= size or target < 0 or target >= size:
            fail("edge index outside node range")
        if not isinstance(relation, int) or relation < 0 or relation >= len(planes):
            fail("unknown relation type")
        if planes[relation][source][target] != 0:
            fail("duplicate tensor edge")
        planes[relation][source][target] = 1

    proposals: list[dict[str, str]] = []
    for left_code, left in enumerate(planes):
        for right_code, right in enumerate(planes):
            product = matmul(left, right)
            for source in range(size):
                for target in range(size):
                    if product[source][target] > 0:
                        proposals.append(
                            {
                                "source": node_ids[source],
                                "target": node_ids[target],
                                "left_relation": relation_names[left_code],
                                "right_relation": relation_names[right_code],
                            }
                        )

    proposals.sort(
        key=lambda item: (
            item["source"],
            item["left_relation"],
            item["right_relation"],
            item["target"],
        )
    )

    json.dump(
        {
            "schema": OUTPUT_SCHEMA,
            "view_key": view_key,
            "proposals": proposals,
        },
        sys.stdout,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
