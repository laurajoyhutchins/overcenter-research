import assert from 'node:assert/strict';
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
    /(?:\.ya?ml|\.sh|\.ts|\.js|\.mjs|\.go|Dockerfile)$/.test(path),
  );
}

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
    go_build:string;
    node_runtime:string;
    node_self_application:string;
  };
  assert.equal(images.schema,'overcenter-runtime-images-v1');
  assert.match(
    images.go_build,
    /^golang:\d+\.\d+\.\d+-bookworm@sha256:[0-9a-f]{64}$/,
  );
  assert.match(
    images.node_runtime,
    /^node:\d+\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}$/,
  );
  assert.match(
    images.node_self_application,
    /^node:\d+\.\d+\.\d+-bookworm@sha256:[0-9a-f]{64}$/,
  );
  assert.ok(images.go_build.startsWith(`golang:${goVersion}-bookworm@sha256:`));
  assert.ok(images.node_runtime.startsWith(`node:${nodeVersion}-bookworm-slim@sha256:`));
  assert.ok(images.node_self_application.startsWith(`node:${nodeVersion}-bookworm@sha256:`));

  for (const path of ['executor/containment/Dockerfile','executor/self-application/Dockerfile']) {
    const dockerfile=read(path);
    assert.match(dockerfile,/^ARG GO_IMAGE$/m);
    assert.match(dockerfile,/^ARG NODE_IMAGE$/m);
    assert.match(dockerfile,/^ARG GO_VERSION$/m);
    assert.match(dockerfile,/^ARG NODE_VERSION$/m);
    assert.match(dockerfile,/^FROM \$\{GO_IMAGE\} AS build$/m);
    assert.match(dockerfile,/^FROM \$\{NODE_IMAGE\}$/m);
    assert.match(dockerfile,/go env GOVERSION/);
    assert.match(dockerfile,/node --version/);
    assert.doesNotMatch(dockerfile,/FROM (?:golang|node):[^$]/);
  }
  const selfApplicationDockerfile=read('executor/self-application/Dockerfile');
  assert.doesNotMatch(selfApplicationDockerfile,/apt-get/);
  assert.match(selfApplicationDockerfile,/git --version/);

  const workflow=read('.github/workflows/computation-executor.yml');
  assert.match(workflow,/go-version-file: '\.go-version'/);
  assert.doesNotMatch(workflow,/go-version-file: executor\/go\.mod/);
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
  assert.match(pkg.scripts['test:unit'],/--test-concurrency=1/);
  assert.match(pkg.scripts['test:experiments'],/--test-concurrency=1/);
});

test('self-application receives exact source bytes without checkout credentials',()=>{
  const workflow=read('.github/workflows/self-application.yml');
  assert.match(workflow,/persist-credentials:\s*false/);

  const selfApplication=read('bin/self-application-evidence.ts');
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

test('production self-application does not size itself around Git reference stress',()=>{
  const selfApplication=read('bin/self-application-evidence.ts');
  assert.match(selfApplication,/npmCli,'run','test:experiments'/);
  assert.match(selfApplication,/self-experiments/);
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
