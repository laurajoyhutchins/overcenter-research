import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {GITHUB_API_VERSION} from '../src/providers/github-contract.ts';
import {
  PRODUCTION_COMPUTATION_CONTAINMENT,
  productionDockerIsolationArgs,
  productionExecutorArgs,
} from '../src/production-containment.ts';

const root=fileURLToPath(new URL('../',import.meta.url));

function read(path:string):string {
  return readFileSync(join(root,path),'utf8');
}

function filesUnder(path:string):string[] {
  const absolute=join(root,path);
  if (!existsSync(absolute)) return [];
  const files:string[]=[];
  for (const entry of readdirSync(absolute)) {
    const relative=join(path,entry);
    const full=join(root,relative);
    if (statSync(full).isDirectory()) files.push(...filesUnder(relative));
    else files.push(relative);
  }
  return files;
}

function executableConfigFiles():string[] {
  const roots=['.github','scripts','src','bin','executor'];
  return roots.flatMap(filesUnder).filter(path=>
    /(?:\.ya?ml|\.sh|\.ts|\.go|Dockerfile)$/.test(path),
  );
}

test('repository contains no tracked JavaScript source',()=>{
  const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'})
    .split('\0')
    .filter(Boolean);
  const javascript=tracked.filter(path=>/\.(?:c|m)?js$|\.jsx$/.test(path));
  assert.deepEqual(javascript,[],'JavaScript source is forbidden; use TypeScript');
});

test('active surfaces use self-application terminology consistently',()=>{
  const legacyTerm=['dog','food'].join('');
  const paths=[...executableConfigFiles(),'README.md','executor/README.md'];
  for (const path of paths) {
    assert.equal(
      read(path).toLowerCase().includes(legacyTerm),
      false,
      `${path} contains legacy self-use terminology`,
    );
  }
});

test('runtime toolchains and executor images have exact checked-in identities',()=>{
  const nodeVersion=read('.node-version').trim();
  const goVersion=read('.go-version').trim();
  assert.match(nodeVersion,/^\d+\.\d+\.\d+$/);
  assert.match(goVersion,/^\d+\.\d+\.\d+$/);

  const images=JSON.parse(read('executor/runtime-images.json')) as {
    schema:string;
    node_runtime:string;
    node_self_application:string;
  };
  assert.equal(images.schema,'overcenter-runtime-images-v2');
  assert.deepEqual(Object.keys(images).sort(),[
    'node_runtime',
    'node_self_application',
    'schema',
  ]);
  assert.match(
    images.node_runtime,
    /^node:\d+\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}$/,
  );
  assert.match(
    images.node_self_application,
    /^node:\d+\.\d+\.\d+-bookworm@sha256:[0-9a-f]{64}$/,
  );
  assert.ok(images.node_runtime.startsWith(`node:${nodeVersion}-bookworm-slim@sha256:`));
  assert.ok(images.node_self_application.startsWith(`node:${nodeVersion}-bookworm@sha256:`));

  for (const path of ['executor/containment/Dockerfile','executor/self-application/Dockerfile']) {
    const dockerfile=read(path);
    assert.match(dockerfile,/^ARG NODE_IMAGE$/m);
    assert.match(dockerfile,/^ARG NODE_VERSION$/m);
    assert.match(dockerfile,/^FROM \$\{NODE_IMAGE\}$/m);
    assert.match(dockerfile,/COPY \.overcenter-build\/overcenter-executor \/usr\/local\/bin\/overcenter-executor/);
    assert.match(dockerfile,/node --version/);
    assert.doesNotMatch(dockerfile,/GO_IMAGE|GO_VERSION|golang:/);
    assert.doesNotMatch(dockerfile,/go build|go env GOVERSION/);
    assert.doesNotMatch(dockerfile,/FROM (?:golang|node):[^$]/);
  }
  const selfApplicationDockerfile=read('executor/self-application/Dockerfile');
  assert.doesNotMatch(selfApplicationDockerfile,/apt-get/);
  assert.match(selfApplicationDockerfile,/git --version/);

  for (const path of [
    '.github/workflows/computation-executor.yml',
    '.github/workflows/self-application.yml',
  ]) {
    const workflow=read(path);
    assert.match(workflow,/go-version-file: '\.go-version'/);
    assert.doesNotMatch(workflow,/go-version-file: executor\/go\.mod/);
  }

  const productionProof=read('scripts/proof-production.sh');
  assert.match(productionProof,/go env GOVERSION/);
  assert.match(productionProof,/CGO_ENABLED=0 go build -trimpath -buildvcs=false/);
  assert.match(productionProof,/build_dir="\.overcenter-build"/);
  assert.match(productionProof,/\.\.\/\$build_dir\/overcenter-executor/);
  const selfApplicationProof=read('scripts/proof-self-application.sh');
  assert.match(selfApplicationProof,/CGO_ENABLED=0 go build -trimpath -buildvcs=false/);
  assert.match(selfApplicationProof,/\.overcenter-build\/overcenter-executor/);
});

test('CI execution substrate and third-party actions are immutable',()=>{
  const paths=filesUnder('.github').filter(path=>/\.ya?ml$/.test(path));
  for (const path of paths) {
    const source=read(path);
    assert.doesNotMatch(source,/ubuntu-latest/,path);
    for (const line of source.split('\n')) {
      const match=line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
      if (!match) continue;
      const spec=match[1];
      if (spec.startsWith('./')) continue;
      assert.match(
        spec,
        /^[^@]+@[0-9a-f]{40}$/i,
        `${path} contains non-immutable action reference: ${spec}`,
      );
    }
  }
});

test('a Rust runtime cannot appear without an exact toolchain pin',()=>{
  const rustSources=filesUnder('runtime').filter(path=>path.endsWith('.rs'));
  if (rustSources.length===0) return;
  assert.ok(existsSync(join(root,'rust-toolchain.toml')),'Rust runtime requires rust-toolchain.toml');
  const toolchain=read('rust-toolchain.toml');
  assert.match(toolchain,/channel\s*=\s*"\d+\.\d+\.\d+"/);
});

test('repository-wide test suites do not inherit host parallelism',()=>{
  const pkg=JSON.parse(read('package.json')) as {scripts:Record<string,string>};
  assert.match(pkg.scripts['test:unit'],/--test-concurrency=2/);
  assert.match(pkg.scripts['test:experiments'],/--test-concurrency=1/);
});

test('PR CI critical paths fail closed within three minutes',()=>{
  const workflows=[
    {
      path:'.github/workflows/tests.yml',
      jobs:['evidence'],
    },
    {
      path:'.github/workflows/computation-executor.yml',
      jobs:['executor'],
    },
    {
      path:'.github/workflows/self-application.yml',
      jobs:['self-evidence'],
    },
    {
      path:'.github/workflows/merge-gate.yml',
      jobs:['evidence','gate'],
    },
    {
      path:'.github/workflows/operator-candidate-certify.yml',
      jobs:['command'],
    },
    {
      path:'.github/workflows/assignment-capsule-proof.yml',
      jobs:['assign','execute','settle'],
    },
    {
      path:'.github/workflows/production-criticality-ranking.yml',
      jobs:['rank'],
    },
  ] as const;

  for (const {path,jobs} of workflows) {
    const workflow=read(path);
    const jobsSource=workflow.slice(workflow.indexOf('\njobs:\n')+'\njobs:\n'.length);
    const actual=[...jobsSource.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)].map(match=>match[1]);
    assert.deepEqual(actual,[...jobs],`${path} changed CI topology without updating the budget model`);
  }

  const budgets=[
    ['.github/workflows/tests.yml','evidence',3],
    ['.github/workflows/computation-executor.yml','executor',2],
    ['.github/workflows/self-application.yml','self-evidence',2],
    ['.github/workflows/merge-gate.yml','gate',1],
    ['.github/workflows/operator-candidate-certify.yml','command',1],
    ['.github/workflows/assignment-capsule-proof.yml','assign',1],
    ['.github/workflows/assignment-capsule-proof.yml','execute',1],
    ['.github/workflows/assignment-capsule-proof.yml','settle',1],
    ['.github/workflows/production-criticality-ranking.yml','rank',3],
  ] as const;

  for (const [path,job,maxMinutes] of budgets) {
    const workflow=read(path);
    const block=workflow.match(
      new RegExp(`(?:^|\\n)  ${job}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|$)`),
    );
    assert.ok(block,`${path} is missing budgeted job ${job}`);
    const timeout=block[1].match(/(?:^|\n)    timeout-minutes:\s*(\d+)\s*(?:\n|$)/);
    assert.ok(timeout,`${path} job ${job} must declare an explicit timeout`);
    assert.ok(
      Number(timeout[1])<=maxMinutes,
      `${path} job ${job} exceeds its ${maxMinutes}-minute CI budget`,
    );
  }

  const mergeGate=read('.github/workflows/merge-gate.yml');
  assert.match(mergeGate,/gate:[\s\S]*?needs: evidence/);

  const assignment=read('.github/workflows/assignment-capsule-proof.yml');
  assert.match(assignment,/execute:[\s\S]*?needs: assign/);
  assert.match(assignment,/settle:[\s\S]*?needs: \[assign, execute\]/);
});

test('self-application receives exact source bytes without checkout credentials',()=>{
  const workflow=read('.github/workflows/self-application.yml');
  assert.match(workflow,/persist-credentials:\s*false/);
  assert.match(workflow,/scripts\/proof-self-application\.sh "\$SOURCE_SHA"/);
  const proofScript=read('scripts/proof-self-application.sh');
  assert.match(proofScript,/--image "\$image"/);
  assert.doesNotMatch(workflow,/OVERCENTER_SELF_APPLICATION_IMAGE/);

  const selfApplication=read('bin/self-application-evidence.ts');
  assert.match(selfApplication,/const image=option\('--image'\)/);
  assert.doesNotMatch(selfApplication,/process\.env\.OVERCENTER_SELF_APPLICATION_IMAGE/);
  assert.match(selfApplication,/git',[\s\S]*?'archive','--format=tar',sourceSha/);
  assert.match(selfApplication,/sourceRoot\}:/);
  assert.doesNotMatch(selfApplication,/repoRoot\}:[^\n]*workspace\/source/);
  assert.match(selfApplication,/SELF_APPLICATION_SOURCE_SNAPSHOT_CONTAINS_GIT_METADATA/);
});

test('live provider proofs cancel superseded heads before consuming provider quota',()=>{
  for (const path of [
    '.github/workflows/conflicting-effect.yml',
    '.github/workflows/disposable-agent-proof.yml',
    '.github/workflows/github-object-transport-proof.yml',
    '.github/workflows/two-effect-concurrency.yml',
    '.github/workflows/github-observation-grammar.yml',
  ]) {
    const source=read(path);
    assert.match(source,/^concurrency:\n/m,path);
    assert.match(source,/cancel-in-progress:\s*true/,path);
    const group=source.match(/^\s*group:\s*(.+)$/m)?.[1]??'';
    assert.match(group,/github\.workflow/,path);
    assert.ok(
      group.includes('github.event.pull_request.number') || group.includes('github.ref'),
      path,
    );
    assert.doesNotMatch(group,/head\.sha/,path);
    assert.doesNotMatch(group,/github\.sha/,path);
  }
});

test('supplemental proofs trigger from evidence dependencies instead of package-script proxies',()=>{
  for (const path of [
    '.github/workflows/datalog-projection.yml',
    '.github/workflows/projection-comparison.yml',
    '.github/workflows/linkml-ontology.yml',
    '.github/workflows/linkml-contract-refactor.yml',
    '.github/workflows/lean-semantic-oracle.yml',
    '.github/workflows/github-observation-grammar.yml',
    '.github/workflows/conflicting-effect.yml',
  ]) {
    const source=read(path);
    assert.doesNotMatch(source,/^\s*-\s*['\"]?package\.json['\"]?\s*$/m,path);
  }
});

test('candidate supplemental proofs do not repeat Merge-gate deterministic coverage',()=>{
  for (const [path,job] of [
    ['.github/workflows/github-observation-grammar.yml','test'],
    ['.github/workflows/kubernetes-observation-semantics.yml','local-semantics'],
    ['.github/workflows/formal-kernel.yml','tlc'],
  ] as const) {
    const workflow=read(path);
    const block=workflow.match(
      new RegExp(`(?:^|\\n)  ${job}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|$)`),
    );
    assert.ok(block,`${path} is missing candidate-deduplicated job ${job}`);
    assert.match(block[1],/github\.event_name != 'pull_request'/,path);
  }

  for (const [path,step] of [
    ['.github/workflows/conflicting-effect.yml','Focused conflict-ordering regression'],
    ['.github/workflows/disposable-agent-proof.yml','Focused disposable-agent regressions'],
  ] as const) {
    const workflow=read(path);
    const index=workflow.indexOf(`- name: ${step}`);
    assert.notEqual(index,-1,`${path} is missing ${step}`);
    const slice=workflow.slice(index,index+240);
    assert.match(slice,/if: \$\{\{ github\.event_name != 'pull_request' \}\}/,path);
  }
});

test('GitHub observation proof is scoped to GitHub provider changes and exact revision checks',()=>{
  const workflow=read('.github/workflows/github-observation-grammar.yml');
  assert.doesNotMatch(workflow,/src\/providers\/\*\*/);
  assert.match(workflow,/src\/providers\/github-\*\.ts/);
  assert.match(workflow,/CHECK_REF:\s*\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
});

test('live supplemental proofs do not recertify the whole repository suite',()=>{
  for (const path of [
    '.github/workflows/github-observation-grammar.yml',
    '.github/workflows/conflicting-effect.yml',
    '.github/workflows/disposable-agent-proof.yml',
  ]) {
    assert.doesNotMatch(read(path),/^\s*run:\s*npm test\s*$/m,path);
  }
});

test('candidate evidence reuses only same-runner exact-revision production work',()=>{
  const evidence=read('.github/workflows/tests.yml');
  const production=read('scripts/proof-production.sh');
  const selfApplication=read('scripts/proof-self-application.sh');

  assert.match(evidence,/OVERCENTER_PREVERIFIED_COMPUTATION_EXECUTOR: '1'[\s\S]*?OVERCENTER_KEEP_BUILD: '1'/);
  assert.match(evidence,/OVERCENTER_REUSE_EXECUTOR: '1'/);
  assert.ok(
    evidence.indexOf('npm run proof:production-boundary') < evidence.indexOf('scripts/proof-self-application.sh'),
    'production proof must precede reuse by self-application',
  );
  assert.match(production,/preverified_computation_executor/);
  assert.match(production,/keep_build/);
  assert.match(selfApplication,/reuse_executor/);
  assert.match(selfApplication,/test -x \.overcenter-build\/overcenter-executor/);
});

test('criticality mutation shares read-only selection and evidence verification on one preflight runner',()=>{
  const workflow=read('.github/workflows/production-criticality-mutation-probe.yml');
  const jobsSource=workflow.slice(workflow.indexOf('\njobs:\n')+'\njobs:\n'.length);
  const actual=[...jobsSource.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)].map(match=>match[1]);
  assert.deepEqual(actual,['preflight','mutate']);
  assert.match(workflow,/preflight:[\s\S]*?Prove evidence machinery[\s\S]*?Bind checked-in evidence to authoritative artifacts/);
  assert.match(workflow,/mutate:[\s\S]*?needs: preflight/);
  assert.doesNotMatch(workflow,/verify-evidence:/);
});

test('assignment capsule proof runs only when its mechanism or execution dependencies change',()=>{
  const workflow=read('.github/workflows/assignment-capsule-proof.yml');
  assert.match(workflow,/pull_request:[\s\S]*?paths:[\s\S]*?assignment-capsule-proof\.yml/);
  assert.match(workflow,/pull_request:[\s\S]*?paths:[\s\S]*?experiments\/assignment-capsule\/\*\*/);
  assert.match(workflow,/pull_request:[\s\S]*?paths:[\s\S]*?src\/\*\*/);
  assert.doesNotMatch(workflow,/pull_request:[\s\S]*?paths:[\s\S]*?test\/\*\*/);
  assert.doesNotMatch(workflow,/pull_request:[\s\S]*?paths:[\s\S]*?\.github\/workflows\/\*\*/);
});

test('GitHub object transport runs only when its mechanism or fixtures change',()=>{
  const workflow=read('.github/workflows/github-object-transport-proof.yml');
  assert.match(workflow,/pull_request:[\s\S]*?paths:[\s\S]*?github-object-transport-proof\.yml/);
  assert.match(workflow,/pull_request:[\s\S]*?paths:[\s\S]*?experiments\/github-object-transport\/\*\*/);
  assert.doesNotMatch(workflow,/pull_request:[\s\S]*?paths:[\s\S]*?package\.json/);
});

test('production self-application proves mechanism without duplicating exhaustive evidence',()=>{
  const selfApplication=read('bin/self-application-evidence.ts');
  assert.match(selfApplication,/test\/digest-pure\.test\.ts/);
  assert.match(selfApplication,/npmCli,'run','test:bounded-graph'/);
  assert.match(selfApplication,/workload_scope:'representative-self-application-witness'/);
  assert.match(selfApplication,/exhaustive_repository_evidence:false/);
  assert.doesNotMatch(selfApplication,/npmCli,'test'/);
  assert.doesNotMatch(selfApplication,/test:experiments/);
  assert.doesNotMatch(selfApplication,/proof:local/);
  const pkg=JSON.parse(read('package.json')) as {scripts:Record<string,string>};
  assert.match(pkg.scripts['proof:local'],/test:stress/);
});

test('ambient credential configuration has one GitHub token spelling',()=>{
  for (const path of executableConfigFiles()) {
    const source=read(path);
    assert.doesNotMatch(source,/\bGH_TOKEN\b/,path);
  }
});

test('operator configuration does not grow ambient authority or transport aliases',()=>{
  const forbidden=['OVERCENTER_DB','DATABASE_URL','OVERCENTER_SOCKET'];
  for (const path of executableConfigFiles()) {
    const source=read(path);
    for (const name of forbidden) {
      assert.equal(source.includes(name),false,`${path} contains forbidden ambient config ${name}`);
    }
  }
});

test('GitHub REST version has one implementation authority',()=>{
  const rest=read('src/providers/github-rest.ts');
  assert.match(rest,/X-GitHub-Api-Version: \$\{GITHUB_API_VERSION\}/);
  assert.deepEqual([...rest.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)],[]);

  const independentProof=read('.github/workflows/github-object-transport-proof.yml');
  const match=independentProof.match(/^\s*API_VERSION:\s*'([^']+)'\s*$/m);
  assert.equal(match?.[1],GITHUB_API_VERSION);
});

test('production containment launch arguments derive from one profile',()=>{
  const profile=PRODUCTION_COMPUTATION_CONTAINMENT;
  const docker=productionDockerIsolationArgs();
  assert.ok(docker.includes(`--network=${profile.network}`));
  assert.ok(docker.includes('--read-only'));
  assert.ok(docker.includes(`--pids-limit=${profile.pids_limit}`));
  assert.ok(docker.includes(`--memory=${profile.memory_bytes}`));
  assert.ok(docker.includes(`--memory-swap=${profile.memory_swap_bytes}`));
  assert.ok(docker.includes(`--ulimit=nofile=${profile.nofile}:${profile.nofile}`));
  assert.ok(docker.includes(`--ulimit=fsize=${profile.file_size_bytes}:${profile.file_size_bytes}`));
  assert.ok(docker.includes(`${profile.tmpfs.path}:${profile.tmpfs.options}`));

  const executor=productionExecutorArgs({
    socketPath:'/control/executor.sock',
    workspaceRoot:'/workspace',
    socketGid:1234,
    executionContextSha256:'sha256:'+'0'.repeat(64),
    containmentId:'test-containment',
  });
  assert.ok(executor.includes(`--concurrency=${profile.executor_concurrency}`));
  assert.ok(executor.includes(`--task-uid=${profile.task_uid}`));
  assert.ok(executor.includes(`--task-gid=${profile.task_gid}`));
});

test('production launchers do not restate containment policy literals',()=>{
  const forbidden=[
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--pids-limit=256',
    '--task-uid=65532',
    '--task-gid=65532',
  ];
  for (const path of [
    'bin/self-application-evidence.ts',
    'test/computation-container.test.ts',
    'scripts/proof-production.sh',
  ]) {
    const source=read(path);
    for (const literal of forbidden) {
      assert.equal(source.includes(literal),false,`${path} duplicates ${literal}`);
    }
  }
});
