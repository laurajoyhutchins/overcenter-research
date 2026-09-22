#!/usr/bin/env python3
"""Deterministic Python code-graph verification-frontier predictor.

The predictor is intentionally dependency-free. It derives a conservative
static graph from Python's stdlib AST, adds a small number of explicit
framework relations, and asks which test functions can reach symbols touched
by a patch.

This is experiment mechanism, not production authority.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import shutil
import tempfile
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Symbol:
    id: str
    path: str
    module: str
    qualname: str
    simple: str
    start: int
    end: int
    kind: str
    is_test: bool


@dataclass(frozen=True)
class ImportRef:
    bound: str
    module: str
    symbol: str | None


def under(path: str, roots: list[str]) -> bool:
    p = Path(path)
    return any(p == Path(root) or Path(root) in p.parents for root in roots)


def module_name(path: str, source_roots: list[str], test_roots: list[str]) -> str:
    p = Path(path)
    parts = list(p.with_suffix("").parts)
    for root in [*source_roots, *test_roots]:
        root_parts = list(Path(root).parts)
        if parts[: len(root_parts)] == root_parts:
            parts = parts[len(root_parts) :]
            break
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def package_name(path: str, module: str) -> str:
    if Path(path).name == "__init__.py":
        return module
    return module.rpartition(".")[0]


def resolve_from_module(
    path: str,
    current_module: str,
    level: int,
    imported_module: str | None,
) -> str:
    if level == 0:
        return imported_module or ""

    package = package_name(path, current_module)
    parts = package.split(".") if package else []
    climb = max(0, level - 1)
    if climb:
        parts = parts[: max(0, len(parts) - climb)]
    if imported_module:
        parts.extend(imported_module.split("."))
    return ".".join(part for part in parts if part)


def definition_start(node: ast.AST) -> int:
    start = getattr(node, "lineno", 1)
    decorators = getattr(node, "decorator_list", ())
    for decorator in decorators:
        start = min(start, getattr(decorator, "lineno", start))
    return start


class DefinitionCollector(ast.NodeVisitor):
    def __init__(self, path: str, module: str, is_test_path: bool):
        self.path = path
        self.module = module
        self.is_test_path = is_test_path
        self.stack: list[str] = []
        self.symbols: list[tuple[Symbol, ast.AST]] = []

    def _add(self, node: ast.AST, name: str, kind: str) -> None:
        qual = ".".join([*self.stack, name])
        sid = f"{self.path}::{qual}"
        symbol = Symbol(
            id=sid,
            path=self.path,
            module=self.module,
            qualname=qual,
            simple=name,
            start=definition_start(node),
            end=getattr(node, "end_lineno", getattr(node, "lineno", 1)),
            kind=kind,
            is_test=self.is_test_path and name.startswith("test_"),
        )
        self.symbols.append((symbol, node))
        self.stack.append(name)
        self.generic_visit(node)
        self.stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._add(node, node.name, "function")

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._add(node, node.name, "function")

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._add(node, node.name, "class")


class ImportCollector(ast.NodeVisitor):
    def __init__(self, path: str, module: str):
        self.path = path
        self.module = module
        self.refs: list[ImportRef] = []

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            bound = alias.asname or alias.name.split(".")[0]
            module = alias.name if alias.asname else alias.name.split(".")[0]
            self.refs.append(ImportRef(bound, module, None))

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        base = resolve_from_module(
            self.path,
            self.module,
            node.level,
            node.module,
        )
        for alias in node.names:
            if alias.name == "*":
                continue
            self.refs.append(
                ImportRef(alias.asname or alias.name, base, alias.name)
            )


class BodyCollector(ast.NodeVisitor):
    """Collect calls without attributing nested definitions to their parent."""

    def __init__(self):
        self.calls: list[ast.Call] = []

    def visit_Call(self, node: ast.Call) -> None:
        self.calls.append(node)
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        return

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        return

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        return


def calls_for(node: ast.AST) -> list[ast.Call]:
    collector = BodyCollector()
    if isinstance(node, ast.Module):
        for statement in node.body:
            collector.visit(statement)
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        for statement in node.body:
            collector.visit(statement)
    else:
        collector.visit(node)
    return collector.calls


def dotted_name(node: ast.AST) -> list[str] | None:
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Attribute):
        base = dotted_name(node.value)
        if base is None:
            return None
        return [*base, node.attr]
    return None


def decorator_command_name(node: ast.AST, function_name: str) -> str | None:
    call = node if isinstance(node, ast.Call) else None
    target = call.func if call is not None else node
    parts = dotted_name(target)
    if not parts or parts[-1] != "command":
        return None

    if call is not None:
        if call.args and isinstance(call.args[0], ast.Constant):
            value = call.args[0].value
            if isinstance(value, str):
                return value
        for keyword in call.keywords:
            if (
                keyword.arg == "name"
                and isinstance(keyword.value, ast.Constant)
                and isinstance(keyword.value.value, str)
            ):
                return keyword.value.value

    return function_name.replace("_", "-")


def literal_command_tokens(call: ast.Call) -> set[str]:
    parts = dotted_name(call.func)
    if not parts or not parts[-1].startswith("invoke"):
        return set()

    tokens: set[str] = set()
    values = [*call.args, *(kw.value for kw in call.keywords)]
    for value in values:
        if not isinstance(value, (ast.List, ast.Tuple)) or not value.elts:
            continue
        first = value.elts[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            tokens.add(first.value)
    return tokens


def parent_class_qualname(
    symbol: Symbol,
    symbols_by_id: dict[str, Symbol],
) -> str | None:
    parts = symbol.qualname.split(".")
    if len(parts) < 2:
        return None
    parent = ".".join(parts[:-1])
    candidate = symbols_by_id.get(f"{symbol.path}::{parent}")
    if candidate and candidate.kind == "class":
        return parent
    return None


def resolve_import_binding(
    ref: ImportRef,
    internal_modules: set[str],
) -> ImportRef:
    if ref.symbol is None:
        return ref

    submodule = ".".join(part for part in (ref.module, ref.symbol) if part)
    if submodule in internal_modules:
        return ImportRef(ref.bound, submodule, None)
    return ref


def import_dependency_module(
    ref: ImportRef,
    internal_modules: set[str],
) -> str | None:
    resolved = resolve_import_binding(ref, internal_modules)
    if resolved.module in internal_modules:
        return resolved.module
    return None


def build_graph(repo: Path, source_roots: list[str], test_roots: list[str]):
    symbols: dict[str, Symbol] = {}
    nodes: dict[str, ast.AST] = {}
    modules_by_path: dict[str, str] = {}
    path_by_module: dict[str, str] = {}
    imports_by_path: dict[str, list[ImportRef]] = {}
    parse_errors: list[str] = []

    files = sorted(
        path
        for path in repo.rglob("*.py")
        if ".git" not in path.parts
        and ".venv" not in path.parts
        and "venv" not in path.parts
        and (
            under(str(path.relative_to(repo)), source_roots)
            or under(str(path.relative_to(repo)), test_roots)
        )
    )

    for file in files:
        rel = file.relative_to(repo).as_posix()
        module = module_name(rel, source_roots, test_roots)
        try:
            source = file.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=rel)
        except (SyntaxError, UnicodeDecodeError):
            parse_errors.append(rel)
            continue

        module_id = f"{rel}::<module>"
        module_symbol = Symbol(
            id=module_id,
            path=rel,
            module=module,
            qualname="<module>",
            simple="<module>",
            start=1,
            end=max(1, len(source.splitlines())),
            kind="module",
            is_test=False,
        )
        symbols[module_id] = module_symbol
        nodes[module_id] = tree
        modules_by_path[rel] = module_id
        path_by_module[module] = rel

        collector = DefinitionCollector(rel, module, under(rel, test_roots))
        collector.visit(tree)
        for symbol, node in collector.symbols:
            symbols[symbol.id] = symbol
            nodes[symbol.id] = node

        imports = ImportCollector(rel, module)
        imports.visit(tree)
        imports_by_path[rel] = imports.refs

    internal_modules = set(path_by_module)
    resolved_imports: dict[str, dict[str, list[ImportRef]]] = {}
    module_edges: dict[str, set[str]] = {
        module_id: set() for module_id in modules_by_path.values()
    }

    for path, refs in imports_by_path.items():
        bindings: dict[str, list[ImportRef]] = defaultdict(list)
        for ref in refs:
            resolved = resolve_import_binding(ref, internal_modules)
            bindings[resolved.bound].append(resolved)
            dependency = import_dependency_module(ref, internal_modules)
            if dependency is not None:
                target_path = path_by_module[dependency]
                module_edges[modules_by_path[path]].add(modules_by_path[target_path])
        resolved_imports[path] = dict(bindings)

    by_simple: dict[str, set[str]] = defaultdict(set)
    by_path_simple: dict[tuple[str, str], set[str]] = defaultdict(set)
    top_by_module: dict[tuple[str, str], str] = {}
    for sid, symbol in symbols.items():
        if symbol.kind == "module":
            continue
        by_simple[symbol.simple].add(sid)
        by_path_simple[(symbol.path, symbol.simple)].add(sid)
        if "." not in symbol.qualname:
            top_by_module[(symbol.module, symbol.simple)] = sid

    edges: dict[str, set[str]] = {sid: set() for sid in symbols}
    unresolved: dict[str, set[str]] = defaultdict(set)
    command_targets: dict[str, set[str]] = defaultdict(set)
    bounded_attribute_fallback_edges = 0

    for sid, symbol in symbols.items():
        node = nodes[sid]
        if (
            symbol.kind == "function"
            and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and under(symbol.path, source_roots)
        ):
            for decorator in node.decorator_list:
                name = decorator_command_name(decorator, symbol.simple)
                if name:
                    command_targets[name].add(sid)

    def resolve_export(
        module: str,
        name: str,
        seen: set[tuple[str, str]] | None = None,
    ) -> set[str]:
        key = (module, name)
        seen = set() if seen is None else seen
        if key in seen:
            return set()
        seen.add(key)

        direct = top_by_module.get(key)
        if direct:
            return {direct}

        path = path_by_module.get(module)
        if path is None:
            return set()

        targets: set[str] = set()
        for ref in resolved_imports.get(path, {}).get(name, []):
            if ref.symbol is not None:
                targets.update(resolve_export(ref.module, ref.symbol, seen))
        return targets

    def imported_symbol_targets(path: str, name: str) -> set[str]:
        targets: set[str] = set()
        for ref in resolved_imports.get(path, {}).get(name, []):
            if ref.symbol is not None:
                targets.update(resolve_export(ref.module, ref.symbol))
        return targets

    def resolve_call(symbol: Symbol, call: ast.Call) -> set[str]:
        nonlocal bounded_attribute_fallback_edges
        target = call.func
        parts = dotted_name(target)
        if not parts:
            return set()

        resolved: set[str] = set()
        class_qual = parent_class_qualname(symbol, symbols)

        if len(parts) == 1:
            name = parts[0]
            local = top_by_module.get((symbol.module, name))
            if local:
                resolved.add(local)

            resolved.update(imported_symbol_targets(symbol.path, name))

            same_path = by_path_simple.get((symbol.path, name), set())
            if len(same_path) == 1:
                resolved.update(same_path)

            if not resolved:
                global_targets = {
                    sid
                    for sid in by_simple.get(name, set())
                    if under(symbols[sid].path, source_roots)
                }
                if len(global_targets) == 1:
                    resolved.update(global_targets)
            return resolved

        first = parts[0]
        attr = parts[-1]

        if first in {"self", "cls"} and class_qual:
            method = f"{symbol.path}::{class_qual}.{attr}"
            if method in symbols:
                resolved.add(method)
            return resolved

        for ref in resolved_imports.get(symbol.path, {}).get(first, []):
            if ref.symbol is not None:
                imported_targets = resolve_export(ref.module, ref.symbol)
                for imported in imported_targets:
                    # Calling a method on an imported callable/class still
                    # depends on the imported object itself.
                    resolved.add(imported)
                    imported_symbol = symbols[imported]
                    if imported_symbol.kind == "class":
                        method = (
                            f"{imported_symbol.path}::"
                            f"{imported_symbol.qualname}.{attr}"
                        )
                        if method in symbols:
                            resolved.add(method)
                continue

            module_parts = ref.module.split(".") if ref.module else []
            suffix = parts[1:-1]
            candidate_module = ".".join([*module_parts, *suffix])
            resolved.update(resolve_export(candidate_module, attr))

        if not resolved and len(parts) == 2:
            class_symbol = top_by_module.get((symbol.module, first))
            if class_symbol and symbols[class_symbol].kind == "class":
                method = (
                    f"{symbols[class_symbol].path}::"
                    f"{symbols[class_symbol].qualname}.{attr}"
                )
                if method in symbols:
                    resolved.add(method)

        if not resolved:
            fallback = {
                candidate
                for candidate in by_simple.get(attr, set())
                if under(symbols[candidate].path, source_roots)
            }
            # Preserve bounded uncertainty instead of restoring v1's
            # unbounded attribute-name fanout.
            if 0 < len(fallback) <= 3:
                resolved.update(fallback)
                bounded_attribute_fallback_edges += len(fallback)

        return resolved

    click_dispatch_edges = 0
    for sid, symbol in symbols.items():
        node = nodes[sid]
        for call in calls_for(node):
            targets = resolve_call(symbol, call)
            if targets:
                edges[sid].update(targets)
            else:
                parts = dotted_name(call.func)
                if parts:
                    unresolved[sid].add(".".join(parts))

            if symbol.is_test:
                for token in literal_command_tokens(call):
                    command_symbols = command_targets.get(token, set())
                    if command_symbols:
                        before = len(edges[sid])
                        edges[sid].update(command_symbols)
                        click_dispatch_edges += len(edges[sid]) - before

        if symbol.kind != "module":
            module_id = modules_by_path.get(symbol.path)
            if module_id:
                edges[sid].add(module_id)

        if symbol.kind == "module":
            edges[sid].update(module_edges.get(sid, set()))

        if symbol.kind == "class":
            init = f"{symbol.path}::{symbol.qualname}.__init__"
            if init in symbols:
                edges[sid].add(init)

    return {
        "symbols": symbols,
        "nodes": nodes,
        "edges": edges,
        "module_edges": module_edges,
        "modules_by_path": modules_by_path,
        "path_by_module": path_by_module,
        "unresolved": unresolved,
        "parse_errors": parse_errors,
        "click_dispatch_edges": click_dispatch_edges,
        "bounded_attribute_fallback_edges": bounded_attribute_fallback_edges,
    }


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
        non_modules = [symbol for symbol in candidates if symbol.kind != "module"]
        hit_any = False
        for start, end in ranges:
            hits = [
                symbol
                for symbol in non_modules
                if not (symbol.end < start or symbol.start > end)
            ]
            if hits:
                min_span = min(symbol.end - symbol.start for symbol in hits)
                tight = [
                    symbol
                    for symbol in hits
                    if (symbol.end - symbol.start) == min_span
                ]
                result.update(symbol.id for symbol in tight)
                hit_any = True
        if not hit_any:
            module = next(
                (symbol for symbol in candidates if symbol.kind == "module"),
                None,
            )
            if module:
                result.add(module.id)
    return result


def patched_parse_failures(
    patched_repo: Path | None,
    patch_text: str,
) -> list[str]:
    if patched_repo is None:
        return []

    failures: list[str] = []
    for path in patch_hunks(patch_text):
        if not path.endswith(".py"):
            continue
        file = patched_repo / path
        if not file.exists():
            continue
        try:
            ast.parse(file.read_text(encoding="utf-8"), filename=path)
        except (SyntaxError, UnicodeDecodeError):
            failures.append(path)
    return sorted(failures)


def reverse_reachable_modules(
    targets: set[str],
    module_edges: dict[str, set[str]],
) -> set[str]:
    reverse: dict[str, set[str]] = defaultdict(set)
    for source, dependencies in module_edges.items():
        for dependency in dependencies:
            reverse[dependency].add(source)

    queue = deque(targets)
    seen = set(targets)
    while queue:
        current = queue.popleft()
        for dependent in reverse.get(current, ()):
            if dependent not in seen:
                seen.add(dependent)
                queue.append(dependent)
    return seen


def import_blast_tests(
    failures: list[str],
    graph: dict,
    test_roots: list[str],
) -> set[str]:
    if not failures:
        return set()

    modules_by_path: dict[str, str] = graph["modules_by_path"]
    failed_modules = {
        modules_by_path[path] for path in failures if path in modules_by_path
    }
    impacted_modules = reverse_reachable_modules(
        failed_modules,
        graph["module_edges"],
    )

    conftest_roots: list[Path] = []
    for path, module_id in modules_by_path.items():
        if module_id in impacted_modules and Path(path).name == "conftest.py":
            conftest_roots.append(Path(path).parent)

    selected: set[str] = set()
    for symbol in graph["symbols"].values():
        if not symbol.is_test:
            continue
        own_module = modules_by_path.get(symbol.path)
        if own_module in impacted_modules:
            selected.add(symbol.id)
            continue
        test_path = Path(symbol.path)
        if any(root == test_path.parent or root in test_path.parents for root in conftest_roots):
            selected.add(symbol.id)
    return selected


def reaches_any(
    start: str,
    targets: set[str],
    edges: dict[str, set[str]],
) -> bool:
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
    patched_repo: Path | None = None,
):
    graph = build_graph(repo, source_roots, test_roots)
    symbols: dict[str, Symbol] = graph["symbols"]
    edges: dict[str, set[str]] = graph["edges"]
    patch_text = patch.read_text(encoding="utf-8")
    changed = changed_symbols(symbols, patch_text)
    tests = sorted(symbol.id for symbol in symbols.values() if symbol.is_test)

    selected = {
        test for test in tests if reaches_any(test, changed, edges)
    }

    parse_failures = patched_parse_failures(patched_repo, patch_text)
    blast = import_blast_tests(parse_failures, graph, test_roots)
    selected.update(blast)

    return {
        "schema": "overcenter-code-graph-frontier/v1",
        "repo": str(repo),
        "patched_repo": str(patched_repo) if patched_repo is not None else None,
        "patch": str(patch),
        "source_roots": source_roots,
        "test_roots": test_roots,
        "changed_symbols": sorted(changed),
        "selected_tests": sorted(selected),
        "all_tests": tests,
        "metrics": {
            "symbols": len(symbols),
            "edges": sum(len(value) for value in edges.values()),
            "tests": len(tests),
            "selected": len(selected),
            "selected_fraction": (len(selected) / len(tests)) if tests else None,
            "unresolved_call_names": sum(
                len(value) for value in graph["unresolved"].values()
            ),
            "base_parse_errors": len(graph["parse_errors"]),
            "patched_changed_file_parse_errors": len(parse_failures),
            "click_dispatch_edges": graph["click_dispatch_edges"],
            "bounded_attribute_fallback_edges": graph[
                "bounded_attribute_fallback_edges"
            ],
            "import_blast_tests": len(blast),
        },
        "diagnostics": {
            "base_parse_errors": graph["parse_errors"],
            "patched_changed_file_parse_errors": parse_failures,
            "import_blast_tests": sorted(blast),
        },
    }


def normalize_test_id(test_id: str) -> str:
    return re.sub(r"\[.*\]$", "", test_id)


def score(predicted: set[str], base: dict[str, str], patched: dict[str, str]):
    universe = set(base) | set(patched)
    affected = {
        test
        for test in universe
        if base.get(test, "missing") != patched.get(test, "missing")
    }
    predicted_n = {normalize_test_id(test) for test in predicted}
    affected_n = {normalize_test_id(test) for test in affected}
    universe_n = {normalize_test_id(test) for test in universe}
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
            1.0 - len(predicted_n) / len(universe_n)
            if universe_n
            else 1.0
        ),
    }


def write(root: Path, relative: str, content: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def self_test() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write(
            root,
            "src/app.py",
            "def changed():\n"
            "    return 1\n\n"
            "def untouched():\n"
            "    return 2\n",
        )
        write(
            root,
            "tests/test_app.py",
            "from app import changed, untouched\n\n"
            "def test_changed():\n"
            "    assert changed() == 1\n\n"
            "def test_untouched():\n"
            "    assert untouched() == 2\n",
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
        assert any(item.endswith("::test_changed") for item in selected), selected
        assert not any(item.endswith("::test_untouched") for item in selected), selected

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

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write(
            root,
            "src/cli.py",
            "def option(*args, **kwargs):\n"
            "    return lambda f: f\n\n"
            "@option(\n"
            "    eager=False,\n"
            ")\n"
            "def run_command():\n"
            "    return 1\n",
        )
        write(
            root,
            "tests/test_cli.py",
            "from cli import run_command\n\n"
            "def test_run():\n"
            "    assert run_command() == 1\n",
        )
        patch = root / "decorator.patch"
        patch.write_text(
            "diff --git a/src/cli.py b/src/cli.py\n"
            "--- a/src/cli.py\n"
            "+++ b/src/cli.py\n"
            "@@ -4,3 +4,3 @@\n"
            " @option(\n"
            "-    eager=False,\n"
            "+    eager=True,\n"
            " )\n",
            encoding="utf-8",
        )
        report = predict(root, patch, ["src"], ["tests"])
        assert report["changed_symbols"] == ["src/cli.py::run_command"], report
        assert report["selected_tests"] == ["tests/test_cli.py::test_run"], report

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write(root, "src/a.py", "def common():\n    return 'a'\n")
        write(root, "src/b.py", "def common():\n    return 'b'\n")
        write(
            root,
            "tests/test_a.py",
            "from a import common\n\n"
            "def test_a():\n"
            "    assert common() == 'a'\n",
        )
        patch = root / "qualified.patch"
        patch.write_text(
            "diff --git a/src/b.py b/src/b.py\n"
            "--- a/src/b.py\n"
            "+++ b/src/b.py\n"
            "@@ -1,2 +1,2 @@\n"
            " def common():\n"
            "-    return 'b'\n"
            "+    return 'changed'\n",
            encoding="utf-8",
        )
        report = predict(root, patch, ["src"], ["tests"])
        assert report["selected_tests"] == [], report

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write(
            root,
            "src/cli.py",
            "import click\n\n"
            "@click.command('routes')\n"
            "def routes_command():\n"
            "    return 1\n",
        )
        write(
            root,
            "tests/test_cli.py",
            "def test_routes(invoke):\n"
            "    result = invoke(['routes'])\n"
            "    assert result\n",
        )
        patch = root / "click.patch"
        patch.write_text(
            "diff --git a/src/cli.py b/src/cli.py\n"
            "--- a/src/cli.py\n"
            "+++ b/src/cli.py\n"
            "@@ -4,2 +4,2 @@\n"
            " def routes_command():\n"
            "-    return 1\n"
            "+    return 2\n",
            encoding="utf-8",
        )
        report = predict(root, patch, ["src"], ["tests"])
        assert report["selected_tests"] == ["tests/test_cli.py::test_routes"], report
        assert report["metrics"]["click_dispatch_edges"] >= 1, report

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write(root, "src/pkg/__init__.py", "from .thing import Thing\n")
        write(
            root,
            "src/pkg/thing.py",
            "class Thing:\n"
            "    def __init__(self):\n"
            "        self.value = 1\n",
        )
        write(
            root,
            "tests/test_reexport.py",
            "import pkg\n\n"
            "def test_thing():\n"
            "    assert pkg.Thing().value == 1\n",
        )
        patch = root / "reexport.patch"
        patch.write_text(
            "diff --git a/src/pkg/thing.py b/src/pkg/thing.py\n"
            "--- a/src/pkg/thing.py\n"
            "+++ b/src/pkg/thing.py\n"
            "@@ -2,2 +2,2 @@\n"
            "     def __init__(self):\n"
            "-        self.value = 1\n"
            "+        self.value = 2\n",
            encoding="utf-8",
        )
        report = predict(root, patch, ["src"], ["tests"])
        assert report["selected_tests"] == [
            "tests/test_reexport.py::test_thing"
        ], report

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write(
            root,
            "src/config.py",
            "class Config:\n"
            "    def from_file(self):\n"
            "        return 1\n",
        )
        write(
            root,
            "tests/test_config.py",
            "def test_config(app):\n"
            "    assert app.config.from_file() == 1\n",
        )
        patch = root / "attribute.patch"
        patch.write_text(
            "diff --git a/src/config.py b/src/config.py\n"
            "--- a/src/config.py\n"
            "+++ b/src/config.py\n"
            "@@ -2,2 +2,2 @@\n"
            "     def from_file(self):\n"
            "-        return 1\n"
            "+        return 2\n",
            encoding="utf-8",
        )
        report = predict(root, patch, ["src"], ["tests"])
        assert report["selected_tests"] == [
            "tests/test_config.py::test_config"
        ], report
        assert report["metrics"]["bounded_attribute_fallback_edges"] >= 1, report

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for index in range(4):
            write(
                root,
                f"src/mod{index}.py",
                f"class C{index}:\n"
                "    def touch(self):\n"
                f"        return {index}\n",
            )
        write(
            root,
            "tests/test_ambiguous.py",
            "def test_touch(obj):\n"
            "    assert obj.touch() is not None\n",
        )
        patch = root / "ambiguous.patch"
        patch.write_text(
            "diff --git a/src/mod0.py b/src/mod0.py\n"
            "--- a/src/mod0.py\n"
            "+++ b/src/mod0.py\n"
            "@@ -2,2 +2,2 @@\n"
            "     def touch(self):\n"
            "-        return 0\n"
            "+        return 99\n",
            encoding="utf-8",
        )
        report = predict(root, patch, ["src"], ["tests"])
        assert report["selected_tests"] == [], report

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory) / "base"
        patched = Path(directory) / "patched"
        write(root, "src/pkg/__init__.py", "from .app import App\n")
        write(root, "src/pkg/app.py", "from . import cli\n\nclass App:\n    pass\n")
        write(root, "src/pkg/cli.py", "def command():\n    return 1\n")
        write(root, "tests/conftest.py", "from pkg import App\n")
        write(root, "tests/test_one.py", "def test_one():\n    assert True\n")
        write(root, "tests/test_two.py", "def test_two():\n    assert True\n")
        shutil.copytree(root, patched)
        write(patched, "src/pkg/cli.py", "def command(:\n    return 1\n")
        patch = Path(directory) / "syntax.patch"
        patch.write_text(
            "diff --git a/src/pkg/cli.py b/src/pkg/cli.py\n"
            "--- a/src/pkg/cli.py\n"
            "+++ b/src/pkg/cli.py\n"
            "@@ -1,2 +1,2 @@\n"
            "-def command():\n"
            "+def command(:\n"
            "     return 1\n",
            encoding="utf-8",
        )
        report = predict(root, patch, ["src"], ["tests"], patched)
        assert report["metrics"]["patched_changed_file_parse_errors"] == 1, report
        assert report["metrics"]["import_blast_tests"] == 2, report
        assert report["selected_tests"] == [
            "tests/test_one.py::test_one",
            "tests/test_two.py::test_two",
        ], report

    print(
        json.dumps(
            {
                "representation": "decorator+qualified+click+parse-import",
                "score": synthetic_score,
            },
            sort_keys=True,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    pred = sub.add_parser("predict")
    pred.add_argument("--repo", type=Path, required=True)
    pred.add_argument("--patched-repo", type=Path)
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
            predict(
                args.repo,
                args.patch,
                source_roots,
                test_roots,
                args.patched_repo,
            ),
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
