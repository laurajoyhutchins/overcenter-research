#!/usr/bin/env python3
"""Deterministic Python code-graph verification-frontier predictor.

The predictor is intentionally conservative and dependency-free. It builds an
approximate static graph from Python's stdlib AST and asks which test functions
can reach symbols touched by a patch.

This is experiment mechanism, not production authority.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import tempfile
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Symbol:
    id: str
    path: str
    qualname: str
    simple: str
    start: int
    end: int
    kind: str
    is_test: bool


def module_name(path: str, source_roots: list[str], test_roots: list[str]) -> str:
    p = Path(path)
    parts = list(p.with_suffix("").parts)
    for root in [*source_roots, *test_roots]:
        rparts = list(Path(root).parts)
        if parts[: len(rparts)] == rparts:
            parts = parts[len(rparts) :]
            break
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


class DefinitionCollector(ast.NodeVisitor):
    def __init__(self, path: str, module: str, is_test_path: bool):
        self.path = path
        self.module = module
        self.is_test_path = is_test_path
        self.stack: list[str] = []
        self.symbols: list[tuple[Symbol, ast.AST]] = []

    def _add(self, node: ast.AST, name: str, kind: str):
        qual = ".".join([*self.stack, name])
        sid = f"{self.path}::{qual}"
        symbol = Symbol(
            id=sid,
            path=self.path,
            qualname=qual,
            simple=name,
            start=getattr(node, "lineno", 1),
            end=getattr(node, "end_lineno", getattr(node, "lineno", 1)),
            kind=kind,
            is_test=self.is_test_path and name.startswith("test_"),
        )
        self.symbols.append((symbol, node))
        self.stack.append(name)
        self.generic_visit(node)
        self.stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef):
        self._add(node, node.name, "function")

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        self._add(node, node.name, "function")

    def visit_ClassDef(self, node: ast.ClassDef):
        self._add(node, node.name, "class")


class CallCollector(ast.NodeVisitor):
    def __init__(self, descend_definitions: bool = True):
        self.names: set[str] = set()
        self.descend_definitions = descend_definitions

    def visit_Call(self, node: ast.Call):
        f = node.func
        if isinstance(f, ast.Name):
            self.names.add(f.id)
        elif isinstance(f, ast.Attribute):
            self.names.add(f.attr)
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef):
        if self.descend_definitions:
            self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        if self.descend_definitions:
            self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef):
        if self.descend_definitions:
            self.generic_visit(node)


def under(path: str, roots: list[str]) -> bool:
    p = Path(path)
    return any(p == Path(r) or Path(r) in p.parents for r in roots)


def build_graph(repo: Path, source_roots: list[str], test_roots: list[str]):
    symbols: dict[str, Symbol] = {}
    nodes: dict[str, ast.AST] = {}
    by_simple: dict[str, set[str]] = defaultdict(set)
    modules: dict[str, str] = {}
    files = sorted(
        p for p in repo.rglob("*.py")
        if ".git" not in p.parts and ".venv" not in p.parts and "venv" not in p.parts
        and (
            under(str(p.relative_to(repo)), source_roots)
            or under(str(p.relative_to(repo)), test_roots)
        )
    )

    parse_errors: list[str] = []
    for file in files:
        rel = file.relative_to(repo).as_posix()
        try:
            source = file.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=rel)
        except (SyntaxError, UnicodeDecodeError):
            parse_errors.append(rel)
            continue
        mod = module_name(rel, source_roots, test_roots)
        module_id = f"{rel}::<module>"
        module_symbol = Symbol(
            id=module_id,
            path=rel,
            qualname="<module>",
            simple="<module>",
            start=1,
            end=max(1, len(source.splitlines())),
            kind="module",
            is_test=False,
        )
        symbols[module_id] = module_symbol
        nodes[module_id] = tree
        modules[rel] = module_id

        collector = DefinitionCollector(rel, mod, under(rel, test_roots))
        collector.visit(tree)
        for symbol, node in collector.symbols:
            symbols[symbol.id] = symbol
            nodes[symbol.id] = node
            by_simple[symbol.simple].add(symbol.id)

    edges: dict[str, set[str]] = {sid: set() for sid in symbols}
    unresolved: dict[str, set[str]] = defaultdict(set)

    for sid, symbol in symbols.items():
        node = nodes[sid]
        calls = CallCollector(descend_definitions=(symbol.kind != "module"))
        calls.visit(node)
        for name in calls.names:
            targets = by_simple.get(name, set())
            if targets:
                edges[sid].update(targets)
            else:
                unresolved[sid].add(name)

        # A callable depends on file-level initialization. This deliberately
        # over-selects when an edit lands at module scope.
        if symbol.kind != "module":
            edges[sid].add(modules[symbol.path])

        # Constructing a class reaches its constructor when statically present.
        if symbol.kind == "class":
            init = f"{symbol.path}::{symbol.qualname}.__init__"
            if init in symbols:
                edges[sid].add(init)

    return symbols, edges, unresolved, parse_errors


HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@")


def patch_hunks(patch_text: str) -> dict[str, list[tuple[int, int]]]:
    changed: dict[str, list[tuple[int, int]]] = defaultdict(list)
    current: str | None = None
    for line in patch_text.splitlines():
        if line.startswith("+++ b/"):
            current = line[6:]
            continue
        if current is None:
            continue
        match = HUNK_RE.match(line)
        if match:
            start = int(match.group(1))
            count = int(match.group(2) or "1")
            end = start + max(count, 1) - 1
            changed[current].append((start, end))
    return dict(changed)


def changed_symbols(symbols: dict[str, Symbol], patch_text: str) -> set[str]:
    hunks = patch_hunks(patch_text)
    result: set[str] = set()
    by_path: dict[str, list[Symbol]] = defaultdict(list)
    for symbol in symbols.values():
        by_path[symbol.path].append(symbol)

    for path, ranges in hunks.items():
        candidates = by_path.get(path, [])
        if not candidates:
            continue
        non_modules = [s for s in candidates if s.kind != "module"]
        hit_any = False
        for start, end in ranges:
            hits = [
                s
                for s in non_modules
                if not (s.end < start or s.start > end)
            ]
            if hits:
                # Nested definitions overlap their parent. Attribute the edit
                # to the narrowest static unit rather than invalidating both.
                min_span = min(s.end - s.start for s in hits)
                tight = [s for s in hits if (s.end - s.start) == min_span]
                result.update(s.id for s in tight)
                hit_any = True
        if not hit_any:
            module = next((s for s in candidates if s.kind == "module"), None)
            if module:
                result.add(module.id)
    return result


def reaches_any(start: str, targets: set[str], edges: dict[str, set[str]]) -> bool:
    queue = deque([start])
    seen = {start}
    while queue:
        current = queue.popleft()
        if current in targets:
            return True
        for nxt in edges.get(current, ()):
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    return False


def predict(
    repo: Path,
    patch: Path,
    source_roots: list[str],
    test_roots: list[str],
):
    symbols, edges, unresolved, parse_errors = build_graph(
        repo, source_roots, test_roots
    )
    patch_text = patch.read_text(encoding="utf-8")
    changed = changed_symbols(symbols, patch_text)
    tests = sorted(s.id for s in symbols.values() if s.is_test)
    selected = sorted(t for t in tests if reaches_any(t, changed, edges))
    return {
        "schema": "overcenter-code-graph-frontier/v1",
        "repo": str(repo),
        "patch": str(patch),
        "source_roots": source_roots,
        "test_roots": test_roots,
        "changed_symbols": sorted(changed),
        "selected_tests": selected,
        "all_tests": tests,
        "metrics": {
            "symbols": len(symbols),
            "edges": sum(len(v) for v in edges.values()),
            "tests": len(tests),
            "selected": len(selected),
            "selected_fraction": (len(selected) / len(tests)) if tests else None,
            "unresolved_call_names": sum(len(v) for v in unresolved.values()),
            "parse_errors": len(parse_errors),
        },
        "diagnostics": {"parse_errors": parse_errors},
    }


def normalize_test_id(test_id: str) -> str:
    return re.sub(r"\[.*\]$", "", test_id)


def score(predicted: set[str], base: dict[str, str], patched: dict[str, str]):
    universe = set(base) | set(patched)
    affected = {
        t for t in universe if base.get(t, "missing") != patched.get(t, "missing")
    }
    predicted_n = {normalize_test_id(t) for t in predicted}
    affected_n = {normalize_test_id(t) for t in affected}
    universe_n = {normalize_test_id(t) for t in universe}
    caught = predicted_n & affected_n
    return {
        "affected": sorted(affected_n),
        "caught": sorted(caught),
        "missed": sorted(affected_n - predicted_n),
        "recall": len(caught) / len(affected_n) if affected_n else 1.0,
        "precision": (
            len(caught) / len(predicted_n)
            if predicted_n
            else (1.0 if not affected_n else 0.0)
        ),
        "selected_fraction": (
            len(predicted_n) / len(universe_n) if universe_n else 0.0
        ),
        "reduction": (
            1.0 - len(predicted_n) / len(universe_n) if universe_n else 1.0
        ),
    }


def self_test():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "src").mkdir()
        (root / "tests").mkdir()
        (root / "src" / "app.py").write_text(
            "def changed():\n"
            "    return 1\n\n"
            "def untouched():\n"
            "    return 2\n",
            encoding="utf-8",
        )
        (root / "tests" / "test_app.py").write_text(
            "from app import changed, untouched\n\n"
            "def test_changed():\n"
            "    assert changed() == 1\n\n"
            "def test_untouched():\n"
            "    assert untouched() == 2\n",
            encoding="utf-8",
        )
        patch = root / "change.patch"
        patch.write_text(
            "diff --git a/src/app.py b/src/app.py\n"
            "--- a/src/app.py\n"
            "+++ b/src/app.py\n"
            "@@ -1,2 +1,2 @@\n"
            " def changed():\n"
            "-    return 1\n"
            "+    return 3\n",
            encoding="utf-8",
        )
        report = predict(root, patch, ["src"], ["tests"])
        selected = report["selected_tests"]
        assert any(x.endswith("::test_changed") for x in selected), selected
        assert not any(x.endswith("::test_untouched") for x in selected), selected

        synthetic_score = score(
            set(selected),
            {
                "tests/test_app.py::test_changed": "pass",
                "tests/test_app.py::test_untouched": "pass",
            },
            {
                "tests/test_app.py::test_changed": "fail",
                "tests/test_app.py::test_untouched": "pass",
            },
        )
        assert synthetic_score["recall"] == 1.0, synthetic_score
        assert synthetic_score["reduction"] == 0.5, synthetic_score
        print(
            json.dumps(
                {"prediction": report["metrics"], "score": synthetic_score},
                sort_keys=True,
            )
        )


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    pred = sub.add_parser("predict")
    pred.add_argument("--repo", type=Path, required=True)
    pred.add_argument("--patch", type=Path, required=True)
    pred.add_argument("--source-root", action="append", default=[])
    pred.add_argument("--test-root", action="append", default=[])

    sub.add_parser("self-test")

    args = parser.parse_args()
    if args.cmd == "self-test":
        self_test()
        return

    source_roots = args.source_root or ["src"]
    test_roots = args.test_root or ["tests"]
    print(
        json.dumps(
            predict(args.repo, args.patch, source_roots, test_roots),
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
