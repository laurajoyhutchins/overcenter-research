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

test('runtime toolchains have one exact checked-in version source',()=>{
  const nodeVersion=read('.node-version').trim();
  const goVersion=read('.go-version').trim();
  assert.match(nodeVersion,/^\d+\.\d+\.\d+$/);
  assert.match(goVersion,/^\d+\.\d+\.\d+$/);

  for (const path of ['executor/containment/Dockerfile','executor/dogfood/Dockerfile']) {
    const dockerfile=read(path);
    assert.match(dockerfile,/^ARG GO_VERSION$/m);
    assert.match(dockerfile,/^ARG NODE_VERSION$/m);
    assert.match(dockerfile,/^FROM golang:\$\{GO_VERSION\}-bookworm AS build$/m);
    assert.match(dockerfile,/^FROM node:\$\{NODE_VERSION\}-bookworm-slim$/m);
  }

  const workflow=read('.github/workflows/computation-executor.yml');
  assert.match(workflow,/go-version-file: '\.go-version'/);
  assert.doesNotMatch(workflow,/go-version-file: executor\/go\.mod/);
});

test('CI execution substrate and third-party actions are immutable',()=>{
  const paths=filesUnder('.github').filter(path=>/\.ya?ml$/.test(path));
  for (const path of paths) {
    const source=read(path);
    assert.doesNotMatch(source,/ubuntu-latest/,path);
    const mutable=[...source.matchAll(/uses:\s+([^\s#]+)@(v\d[^\s#]*)/g)]
      .map(match=>match[0]);
    assert.deepEqual(mutable,[],`${path} contains mutable actions: ${mutable.join(', ')}`);
  }
});

test('a Rust runtime cannot appear without an exact toolchain pin',()=>{
  const rustSources=filesUnder('runtime').filter(path=>path.endsWith('.rs'));
  if (rustSources.length===0) return;
  assert.ok(existsSync(join(root,'rust-toolchain.toml')),'Rust runtime requires rust-toolchain.toml');
  const toolchain=read('rust-toolchain.toml');
  assert.match(toolchain,/channel\s*=\s*"\d+\.\d+\.\d+"/);
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
    '--pids-limit=64',
    '--task-uid=65532',
    '--task-gid=65532',
  ];
  for (const path of [
    'bin/dogfood-evidence.ts',
    'test/computation-container.test.ts',
    'scripts/proof-production.sh',
  ]) {
    const source=read(path);
    for (const literal of forbidden) {
      assert.equal(source.includes(literal),false,`${path} duplicates ${literal}`);
    }
  }
});
