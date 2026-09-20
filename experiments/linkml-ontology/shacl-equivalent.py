#!/usr/bin/env python3
import sys

from rdflib import Graph
from rdflib.compare import isomorphic


def load(path: str) -> Graph:
    graph = Graph()
    graph.parse(path, format="turtle")
    return graph


if len(sys.argv) != 3:
    raise SystemExit("usage: shacl-equivalent.py LEFT.ttl RIGHT.ttl")

raise SystemExit(0 if isomorphic(load(sys.argv[1]), load(sys.argv[2])) else 1)
