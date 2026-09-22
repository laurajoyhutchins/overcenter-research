#!/usr/bin/env python3
"""Execute one Flask case against an immutable SWE-bench image."""
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


def run(
    args: list[str],
    *,
    cwd: Path | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
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
    inspected = run(
        [
            "docker",
            "image",
            "inspect",
            image,
            "--format",
            "{{json .RepoDigests}}",
        ]
    )
    digests = json.loads(inspected.stdout.strip())
    if not digests:
        raise RuntimeError(f"image has no immutable RepoDigest: {image}")
    repository = image.rsplit(":", 1)[0]
    matching = [digest for digest in digests if digest.startswith(repository + "@")]
    return (matching or digests)[0]


def container_base_revision(image_digest: str) -> str:
    result = run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "/bin/bash",
            image_digest,
            "-lc",
            "git -C /testbed rev-parse HEAD",
        ]
    )
    return result.stdout.strip()


def container_test(
    *,
    image_digest: str,
    experiment_dir: Path,
    result_dir: Path,
    patches: list[str],
    stem: str,
) -> int:
    result_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(result_dir, 0o777)

    apply = []
    for relative in patches:
        mounted = "/experiment/" + relative
        quoted = shlex.quote(mounted)
        apply.append(f"git apply --check {quoted}")
        apply.append(f"git apply {quoted}")

    script = "\n".join(
        [
            "set -euo pipefail",
            "cd /testbed",
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
            f'test -f /results/{stem}.xml',
            "exit 0",
        ]
    )

    run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "-v",
            f"{experiment_dir}:/experiment:ro",
            "-v",
            f"{result_dir}:/results",
            "--entrypoint",
            "/bin/bash",
            image_digest,
            "-lc",
            script,
        ]
    )
    return int((result_dir / f"{stem}.exit").read_text(encoding="utf-8").strip())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--flask-repo", type=Path, required=True)
    parser.add_argument("--case", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    corpus = json.loads((HERE / "corpus.json").read_text(encoding="utf-8"))
    case = next((item for item in corpus["cases"] if item["id"] == args.case), None)
    if case is None:
        raise SystemExit(f"unknown case: {args.case}")

    repo = args.flask_repo.resolve()
    out = args.out.resolve() / case["id"]
    out.mkdir(parents=True, exist_ok=True)

    image = image_name(case["id"])
    digest = resolve_image_digest(image)
    observed_base = container_base_revision(digest)
    if observed_base != case["base_commit"]:
        raise SystemExit(
            f"SWE-bench image base mismatch for {case['id']}: "
            f"expected {case['base_commit']}, observed {observed_base}"
        )

    test_patch = case["test_patch"]
    base_dir = out / "_base"
    base_exit = container_test(
        image_digest=digest,
        experiment_dir=HERE,
        result_dir=base_dir,
        patches=[test_patch],
        stem="base",
    )

    (out / "case.json").write_text(
        json.dumps(
            {
                "schema": "overcenter-code-graph-verification-case/v1",
                "case": case["id"],
                "base_commit": case["base_commit"],
                "image_tag": image,
                "environment_id": digest,
                "observed_image_base_commit": observed_base,
                "base_pytest_exit": base_exit,
                "docker_version": run(["docker", "--version"]).stdout.strip(),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    with tempfile.TemporaryDirectory(prefix=f"code-graph-{case['id']}-") as tmp:
        worktree = Path(tmp) / "base"
        run(
            [
                "git",
                "-C",
                str(repo),
                "worktree",
                "add",
                "--detach",
                str(worktree),
                case["base_commit"],
            ]
        )
        try:
            run(
                ["git", "apply", str((HERE / test_patch).resolve())],
                cwd=worktree,
            )

            for variant in case["variants"]:
                variant_dir = out / variant["id"]
                variant_dir.mkdir(parents=True, exist_ok=True)
                frontier = variant_dir / "frontier.json"
                patch = (HERE / variant["patch"]).resolve()

                with frontier.open("w", encoding="utf-8") as handle:
                    prediction = subprocess.run(
                        [
                            sys.executable,
                            str(HERE / "frontier.py"),
                            "predict",
                            "--repo",
                            str(worktree),
                            "--patch",
                            str(patch),
                            "--source-root",
                            "src",
                            "--test-root",
                            "tests",
                        ],
                        text=True,
                        stdout=handle,
                        stderr=subprocess.PIPE,
                        check=False,
                    )
                if prediction.returncode != 0:
                    raise RuntimeError(
                        f"frontier failed for {case['id']}/{variant['id']}: "
                        f"{prediction.stderr}"
                    )

                patched_exit = container_test(
                    image_digest=digest,
                    experiment_dir=HERE,
                    result_dir=variant_dir,
                    patches=[test_patch, variant["patch"]],
                    stem="patched",
                )

                shutil.copy2(base_dir / "base.xml", variant_dir / "base.xml")
                shutil.copy2(base_dir / "base.log", variant_dir / "base.log")
                shutil.copy2(base_dir / "base.exit", variant_dir / "base.exit")

                run_json = {
                    "schema": "overcenter-code-graph-verification-run/v1",
                    "case": case["id"],
                    "variant": variant["id"],
                    "authorship": variant["authorship"],
                    "equivalence_group": variant["equivalence_group"],
                    "base_commit": case["base_commit"],
                    "environment_id": digest,
                    "image_tag": image,
                    "base_pytest_exit": base_exit,
                    "patched_pytest_exit": patched_exit,
                    "frontier": str(frontier),
                }
                (variant_dir / "run.json").write_text(
                    json.dumps(run_json, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )

                run(
                    [
                        sys.executable,
                        str(HERE / "score.py"),
                        "--frontier",
                        str(frontier),
                        "--base-junit",
                        str(variant_dir / "base.xml"),
                        "--patched-junit",
                        str(variant_dir / "patched.xml"),
                        "--out",
                        str(variant_dir / "score.json"),
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
                    str(worktree),
                ],
                check=False,
            )

    print(
        json.dumps(
            {
                "case": case["id"],
                "environment_id": digest,
                "variants": len(case["variants"]),
                "out": str(out),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
