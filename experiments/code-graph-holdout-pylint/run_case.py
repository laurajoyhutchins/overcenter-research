#!/usr/bin/env python3
"""Execute one Pylint holdout case under immutable SWE-bench environment identity."""
from __future__ import annotations

import argparse,json,os,shlex,shutil,subprocess,sys,tempfile
from pathlib import Path

HERE=Path(__file__).resolve().parent
GRAPH=HERE.parent/"code-graph-verification"/"frontier.py"
SCORE=HERE.parent/"code-graph-verification"/"score.py"


def run(args:list[str],*,cwd:Path|None=None,check:bool=True)->subprocess.CompletedProcess[str]:
    r=subprocess.run(args,cwd=cwd,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False)
    if check and r.returncode:
        raise RuntimeError(f"command failed ({r.returncode}): {args}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}")
    return r


def image_name(instance_id:str)->str:
    return "swebench/sweb.eval.x86_64."+instance_id.lower().replace("__","_1776_")+":latest"


def image_digest(image:str)->str:
    run(["docker","pull",image])
    r=run(["docker","image","inspect",image,"--format","{{json .RepoDigests}}"])
    ds=json.loads(r.stdout.strip())
    if not ds:
        raise RuntimeError(f"no immutable RepoDigest: {image}")
    repo=image.rsplit(":",1)[0]
    return next((d for d in ds if d.startswith(repo+"@")),ds[0])


def probe(digest:str,base:str)->dict[str,str]:
    script="\n".join([
        "set -euo pipefail","cd /testbed",
        'printf "initial=%s\\n" "$(git rev-parse HEAD)"',
        f"git cat-file -e {base}^{{commit}}",
        f"git reset --hard {base} >/dev/null",
        'printf "reset=%s\\n" "$(git rev-parse HEAD)"'
    ])
    r=run(["docker","run","--rm","--network","none","--entrypoint","/bin/bash",digest,"-lc",script])
    values=dict(line.split("=",1) for line in r.stdout.splitlines() if "=" in line)
    if values.get("reset")!=base:
        raise RuntimeError(f"source reset mismatch: {values}")
    return values


def container_test(*,digest:str,result_dir:Path,base:str,patches:list[str],stem:str)->int:
    result_dir.mkdir(parents=True,exist_ok=True)
    os.chmod(result_dir,0o777)
    apply=[]
    for relative in patches:
        q=shlex.quote("/experiment/"+relative)
        apply.extend([f"git apply --check {q}",f"git apply {q}"])
    script="\n".join([
        "set -euo pipefail","cd /testbed",
        f"git cat-file -e {base}^{{commit}}",f"git reset --hard {base} >/dev/null",
        f'test "$(git rev-parse HEAD)" = "{base}"',*apply,
        'PYTHON=/opt/miniconda3/envs/testbed/bin/python',
        'if [ ! -x "$PYTHON" ]; then PYTHON="$(command -v python)"; fi',
        "set +e",f'"$PYTHON" -m pytest -q --junitxml=/results/{stem}.xml 2>&1 | tee /results/{stem}.log',
        'status="${PIPESTATUS[0]}"',"set -e",
        f'printf "%s\\n" "$status" > /results/{stem}.exit',
        f'if [ ! -f /results/{stem}.xml ]; then',
        f'  printf "%s\\n" \'<testsuites><testsuite name="pytest-session-aborted" tests="0" failures="0" errors="1"/></testsuites>\' > /results/{stem}.xml',
        f'  touch /results/{stem}.junit-synthesized',"fi","exit 0"
    ])
    run(["docker","run","--rm","--network","none","-v",f"{HERE}:/experiment:ro","-v",f"{result_dir}:/results","--entrypoint","/bin/bash",digest,"-lc",script])
    return int((result_dir/f"{stem}.exit").read_text().strip())


def main()->None:
    p=argparse.ArgumentParser()
    p.add_argument("--pylint-repo",type=Path,required=True)
    p.add_argument("--case",required=True)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    corpus=json.loads((HERE/"corpus.json").read_text())
    case=next((c for c in corpus["cases"] if c["id"]==args.case),None)
    if case is None:
        raise SystemExit(f"unknown case {args.case}")
    rep=corpus["representation"]
    repo=args.pylint_repo.resolve()
    out=args.out.resolve()/case["id"]; out.mkdir(parents=True,exist_ok=True)
    image=image_name(case["id"]); digest=image_digest(image); source=probe(digest,case["base_commit"])
    test_patch=case["test_patch"]; base_dir=out/"_base"
    base_exit=container_test(digest=digest,result_dir=base_dir,base=case["base_commit"],patches=[test_patch],stem="base")
    if (base_dir/"base.junit-synthesized").exists():
        raise RuntimeError(f"base suite aborted for {case['id']}")
    (out/"case.json").write_text(json.dumps({
        "schema":"overcenter-code-graph-holdout-case/v1","case":case["id"],
        "base_commit":case["base_commit"],"image_tag":image,"environment_id":digest,
        "image_initial_head":source["initial"],"source_reset_commit":source["reset"],
        "base_pytest_exit":base_exit,"docker_version":run(["docker","--version"]).stdout.strip()
    },indent=2,sort_keys=True)+"\n")

    with tempfile.TemporaryDirectory(prefix=f"pylint-holdout-{case['id']}-") as tmp:
        base=Path(tmp)/"base"
        run(["git","-C",str(repo),"worktree","add","--detach",str(base),case["base_commit"]])
        try:
            run(["git","apply",str((HERE/test_patch).resolve())],cwd=base)
            for index,variant in enumerate(case["variants"]):
                vd=out/variant["id"]; vd.mkdir(parents=True,exist_ok=True)
                patched=Path(tmp)/f"patched-{index}"
                run(["git","-C",str(repo),"worktree","add","--detach",str(patched),case["base_commit"]])
                try:
                    run(["git","apply",str((HERE/test_patch).resolve())],cwd=patched)
                    patch=(HERE/variant["patch"]).resolve(); run(["git","apply",str(patch)],cwd=patched)
                    frontier=vd/"frontier.json"
                    cmd=[sys.executable,str(GRAPH),"predict","--repo",str(base),"--patched-repo",str(patched),"--patch",str(patch)]
                    for root in rep["source_roots"]: cmd.extend(["--source-root",root])
                    for root in rep["test_roots"]: cmd.extend(["--test-root",root])
                    with frontier.open("w") as h:
                        pr=subprocess.run(cmd,text=True,stdout=h,stderr=subprocess.PIPE,check=False)
                    if pr.returncode:
                        raise RuntimeError(f"frontier failed {case['id']}/{variant['id']}: {pr.stderr}")
                finally:
                    run(["git","-C",str(repo),"worktree","remove","--force",str(patched)],check=False)

                patched_exit=container_test(digest=digest,result_dir=vd,base=case["base_commit"],patches=[test_patch,variant["patch"]],stem="patched")
                synthesized=(vd/"patched.junit-synthesized").exists()
                for name in ["base.xml","base.log","base.exit"]: shutil.copy2(base_dir/name,vd/name)
                (vd/"run.json").write_text(json.dumps({
                    "schema":"overcenter-code-graph-holdout-run/v1","case":case["id"],"variant":variant["id"],
                    "authorship":variant["authorship"],"base_commit":case["base_commit"],
                    "environment_id":digest,"image_tag":image,"base_pytest_exit":base_exit,
                    "patched_pytest_exit":patched_exit,"patched_junit_synthesized":synthesized
                },indent=2,sort_keys=True)+"\n")
                run([sys.executable,str(SCORE),"--frontier",str(vd/"frontier.json"),"--base-junit",str(vd/"base.xml"),"--patched-junit",str(vd/"patched.xml"),"--out",str(vd/"score.json")])
        finally:
            run(["git","-C",str(repo),"worktree","remove","--force",str(base)],check=False)
    print(json.dumps({"case":case["id"],"environment_id":digest,"variants":len(case["variants"])}))


if __name__=="__main__":
    main()
