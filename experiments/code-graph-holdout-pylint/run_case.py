#!/usr/bin/env python3
"""Execute one Pylint holdout case with the frozen graph representation."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
GRAPH = HERE.parent / "code-graph-verification" / "frontier.py"
SCORE = HERE.parent / "code-graph-verification" / "score.py"


def run(
    args: list[str],
    *,
    cwd: Path | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args, cwd=cwd, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"command failed ({result.returncode}): {args}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def image_name(instance_id: str) -> str:
    remote_id = instance_id.lower().replace("__", "_1776_")
    return f"swebench/sweb.eval.x86_64.{remote_id}:latest"


def resolve_image_digest(image: str) -> str:
    run(["docker", "pull", image])
    inspected = run([
        "docker", "image", "inspect", image,
        "--format", "{{json .RepoDigests}}"
    ])
    digests = json.loads(inspected.stdout.strip())
    if not digests:
        raise RuntimeError(f"image has no immutable RepoDigest: {image}")
    repository = image.rsplit(":", 1)[0]
    matching = [d for d in digests if d.startswith(repository + "@")]
    return (matching or digests)[0]


def source_probe(image_digest: str, base_commit: str) -> dict[str, str]:
    script = "\n".join([
        "set -euo pipefail",
        "cd /testbed",
        'printf "initial=%s\\n" "$(git rev-parse HEAD)"',
        f"git cat-file -e {base_commit}^{{commit}}",
        f"git reset --hard {base_commit} >/dev/null",
        'printf "reset=%s\\n" "$(git rev-parse HEAD)"',
    ])
    result = run([
        "docker", "run", "--rm", "--network", "none",
        "--entrypoint", "/bin/bash", image_digest, "-lc", script
    ])
    values = dict(
        line.split("=", 1)
        for line in result.stdout.splitlines()
        if "=" in line
    )
    if values.get("reset") != base_commit:
        raise RuntimeError(
            f"container could not reset to {base_commit}: {values}"
        )
    return values


def container_test(
    *,
    image_digest: str,
    result_dir: Path,
    base_commit: str,
    patches: list[str],
    stem: str,
) -> int:
    result_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(result_dir, 0o777)
    apply = []
    for relative in patches:
        q = shlex.quote("/experiment/" + relative)
        apply.extend([f"git apply --check {q}", f"git apply {q}"])
    script = "\n".join([
        "set -euo pipefail",
        "cd /testbed",
        f"git cat-file -e {base_commit}^{{commit}}",
        f"git reset --hard {base_commit} >/dev/null",
        f'test "$(git rev-parse HEAD)" = "{base_commit}"',
        *apply,
        'PYTHON=/opt/miniconda3/envs/testbed/bin/python',
        'if [ ! -x "$PYTHON" ]; then PYTHON="$(command -v python)"; fi',
        "set +e",
        (
            f'"$PYTHON" -m pytest -q --junitxml=/results/{stem}.xml '
            f'2>&1 | tee /results/{stem}.log'
        ),
        'status="${PIPESTATUS[0]}"',
        "set -e",
        f'printf "%s\\n" "$status" > /results/{stem}.exit',
        f'if [ ! -f /results/{stem}.xml ]; then',
        (
            f'  printf "%s\\n" '
            f'\'<testsuites><testsuite name="pytest-session-aborted" '
            f'tests="0" failures="0" errors="1"/></testsuites>\' '
            f'> /results/{stem}.xml'
        ),
        f'  touch /results/{stem}.junit-synthesized',
        "fi",
        "exit 0",
    ])
    run([
        "docker", "run", "--rm", "--network", "none",
        "-v", f"{HERE}:/experiment:ro",
        "-v", f"{result_dir}:/results",
        "--entrypoint", "/bin/bash", image_digest, "-lc", script
    ])
    return int(
        (result_dir / f"{stem}.exit")
        .read_text(encoding="utf-8").strip()
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pylint-repo", type=Path, required=True)
    parser.add_argument("--case", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    corpus = json.loads((HERE / "corpus.json").read_text(encoding="utf-8"))
    case = next(
        (c for c in corpus["cases"] if c["id"] == args.case),
        None,
    )
    if case is None:
        raise SystemExit(f"unknown case: {args.case}")
    roots = corpus["representation"]
    repo = args.pylint_repo.resolve()
    out = args.out.resolve() / case["id"]
    out.mkdir(parents=True, exist_ok=True)

    image = image_name(case["id"])
    digest = resolve_image_digest(image)
    probe = source_probe(digest, case["base_commit"])
    test_patch = case["test_patch"]

    base_dir = out / "_base"
    base_exit = container_test(
        image_digest=digest,
        result_dir=base_dir,
        base_commit=case["base_commit"],
        patches=[test_patch],
        stem="base",
    )
    if (base_dir / "base.junit-synthesized").exists():
        raise RuntimeError(
            f"base suite for {case['id']} aborted before producing JUnit"
        )

    (out / "case.json").write_text(
        json.dumps({
            "schema": "overcenter-code-graph-holdout-case/v1",
            "case": case["id"],
            "base_commit": case["base_commit"],
            "image_tag": image,
            "environment_id": digest,
            "image_initial_head": probe["initial"],
            "source_reset_commit": probe["reset"],
            "base_pytest_exit": base_exit,
            "docker_version": run(["docker", "--version"]).stdout.strip(),
        }, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    with tempfile.TemporaryDirectory(
        prefix=f"pylint-holdout-{case['id']}-"
    ) as tmp:
        base = Path(tmp) / "base"
        run([
            "git", "-C", str(repo), "worktree", "add", "--detach",
            str(base), case["base_commit"]
        ])
        try:
            run([
                "git", "apply", str((HERE / test_patch).resolve())
            ], cwd=base)

            for index, variant in enumerate(case["variants"]):
                variant_dir = out / variant["id"]
                variant_dir.mkdir(parents=True, exist_ok=True)
                patched = Path(tmp) / f"patched-{index}"
                run([
                    "git", "-C", str(repo), "worktree", "add", "--detach",
                    str(patched), case["base_commit"]
                ])
                try:
                    run([
                        "git", "apply",
                        str((HERE / test_patch).resolve())
                    ], cwd=patched)
                    patch = (HERE / variant["patch"]).resolve()
                    run(["git", "apply", str(patch)], cwd=patched)

                    frontier = variant_dir / "frontier.json"
                    cmd = [
                        sys.executable, str(GRAPH), "predict",
                        "--repo", str(base),
                        "--patched-repo", str(patched),
                        "--patch", str(patch),
                    ]
                    for root in roots["source_roots"]:
                        cmd.extend(["--source-root", root])
                    for root in roots["test_roots"]:
                        cmd.extend(["--test-root", root])
                    with frontier.open("w", encoding="utf-8") as handle:
                        pred = subprocess.run(
                            cmd,
                            text=True,
                            stdout=handle,
                            stderr=subprocess.PIPE,
                            check=False,
                        )
                    if pred.returncode != 0:
                        raise RuntimeError(
                            f"frontier failed for "
                            f"{case['id']}/{variant['id']}: "
                            f"{pred.stderr}"
                        )
                finally:
                    run([
                        "git", "-C", str(repo), "worktree",
                        "remove", "--force", str(patched)
                    ], check=False)

                patched_exit = container_test(
                    image_digest=digest,
                    result_dir=variant_dir,
                    base_commit=case["base_commit"],
                    patches=[test_patch, variant["patch"]],
                    stem="patched",
                )
                synthesized = (
                    variant_dir / "patched.junit-synthesized"
                ).exists()
                for name in ["base.xml", "base.log", "base.exit"]:
                    shutil.copy2(base_dir / name, variant_dir / name)

                (variant_dir / "run.json").write_text(
                    json.dumps({
                        "schema": "overcenter-code-graph-holdout-run/v1",
                        "case": case["id"],
                        "variant": variant["id"],
                        "authorship": variant["authorship"],
                        "base_commit": case["base_commit"],
                        "environment_id": digest,
                        "image_tag": image,
                        "base_pytest_exit": base_exit,
                        "patched_pytest_exit": patched_exit,
                        "patched_junit_synthesized": synthesized,
                    }, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                run([
                    sys.executable, str(SCORE),
                    "--frontier", str(variant_dir / "frontier.json"),
                    "--base-junit", str(variant_dir / "base.xml"),
                    "--patched-junit", str(variant_dir / "patched.xml"),
                    "--out", str(variant_dir / "score.json"),
                ])
        finally:
            run([
                "git", "-C", str(repo), "worktree",
                "remove", "--force", str(base)
            ], check=False)

    print(json.dumps({
        "case": case["id"],
        "environment_id": digest,
        "variants": len(case["variants"]),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
