import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { GITHUB_API_VERSION } from '../src/providers/github-contract.ts';

const repoRoot=fileURLToPath(new URL('../',import.meta.url));

function read(path:string):string {
  return readFileSync(join(repoRoot,path),'utf8');
}

function filesUnder(path:string):string[] {
  const absolute=join(repoRoot,path);
  if (!existsSync(absolute)) return [];
  const result:string[]=[];
  for (const entry of readdirSync(absolute,{withFileTypes:true})) {
    const child=join(absolute,entry.name);
    if (entry.isDirectory()) {
      result.push(...filesUnder(relative(repoRoot,child)));
    } else if (entry.isFile()) {
      result.push(relative(repoRoot,child));
    }
  }
  return result;
}

function executableConfigFile(path:string):boolean {
  return ['.ts','.js','.mjs','.sh','.go','.yml','.yaml'].includes(extname(path))
    || path.endsWith('Dockerfile');
}

test('runtime toolchain versions have one exact checked-in source',()=>{
  const nodeVersion=read('.node-version').trim();
  const goVersion=read('.go-version').trim();
  assert.match(nodeVersion,/^\d+\.\d+\.\d+$/);
  assert.match(goVersion,/^\d+\.\d+\.\d+$/);

  const goModVersion=read('executor/go.mod').match(/^go (\d+\.\d+)$/m)?.[1];
  assert.ok(goModVersion);
  assert.ok(goVersion.startsWith(goModVersion+'.'));

  for (const path of [
    'executor/containment/Dockerfile',
    'executor/dogfood/Dockerfile',
  ]) {
    const dockerfile=read(path);
    assert.match(dockerfile,/^ARG GO_VERSION$/m);
    assert.match(dockerfile,/^ARG NODE_VERSION$/m);
    assert.match(dockerfile,/^FROM golang:\$\{GO_VERSION\}-bookworm AS build$/m);
    assert.match(dockerfile,/^FROM node:\$\{NODE_VERSION\}-bookworm-slim$/m);
    assert.doesNotMatch(dockerfile,/^FROM golang:\d/m);
    assert.doesNotMatch(dockerfile,/^FROM node:\d/m);
  }
});

test('CI uses pinned runners, immutable actions, and canonical language version files',()=>{
  const workflowPaths=filesUnder('.github/workflows')
    .filter(path=>/\.ya?ml$/.test(path));
  const actionPaths=filesUnder('.github/actions')
    .filter(path=>/\.ya?ml$/.test(path));

  for (const path of [...workflowPaths,...actionPaths]) {
    const source=read(path);
    assert.doesNotMatch(source,/^\s*runs-on:\s*[^#\n]*latest\b/m,path+' uses a floating runner');

    for (const line of source.split('\n')) {
      const match=line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/);
      if (!match) continue;
      const spec=match[1].replace(/^['"]|['"]$/g,'');
      if (spec.startsWith('./')) continue;
      const at=spec.lastIndexOf('@');
      assert.ok(at>0,path+' has an unversioned external action: '+spec);
      assert.match(spec.slice(at+1),/^[0-9a-f]{40}$/,path+' has a mutable action ref: '+spec);
    }

    if (source.includes('actions/setup-node@')) {
      assert.doesNotMatch(source,/^\s*node-version:\s*/m,path+' duplicates Node version');
      assert.match(source,/^\s*node-version-file:\s*['"]?\.node-version['"]?\s*$/m,path+' must use .node-version');
    }
    if (source.includes('actions/setup-go@')) {
      assert.doesNotMatch(source,/^\s*go-version:\s*/m,path+' duplicates Go version');
      assert.match(source,/^\s*go-version-file:\s*['"]?\.go-version['"]?\s*$/m,path+' must use .go-version');
    }

    if (/fstar/i.test(path)) {
      assert.doesNotMatch(source,/FStar\/releases\/download/,path+' duplicates the F* installer');
      assert.match(source,/uses:\s*\.\/\.github\/actions\/setup-fstar/,path+' must use the shared F* installer');
    }
  }

  const rustWorkflows=workflowPaths.filter(path=>/rust/i.test(path));
  if (rustWorkflows.length>0) {
    assert.ok(existsSync(join(repoRoot,'rust-toolchain.toml')),'Rust workflows require rust-toolchain.toml');
    assert.match(read('rust-toolchain.toml'),/^channel\s*=\s*"\d+\.\d+\.\d+"$/m);
  }
});

test('GitHub API version has one production authority and an independent drift-checked proof copy',()=>{
  const rest=read('src/providers/github-rest.ts');
  assert.match(rest,/import \{ GITHUB_API_VERSION \} from '\.\/github-contract\.ts';/);
  assert.doesNotMatch(rest,/X-GitHub-Api-Version:\s*\d{4}-\d{2}-\d{2}/);

  const transport=read('.github/workflows/github-object-transport-proof.yml');
  const proofVersion=transport.match(/^\s*API_VERSION:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m)?.[1];
  assert.equal(proofVersion,GITHUB_API_VERSION);
});

test('ambient configuration stays narrow',()=>{
  const liveProof=read('scripts/proof-live.sh');
  assert.match(liveProof,/unset GH_TOKEN/);
  const productionProof=read('scripts/proof-production.sh');
  assert.doesNotMatch(productionProof,/OVERCENTER_EXECUTOR_(?:CONTAINER_NAME|WORKDIR)/);

  for (const root of ['.github','scripts','src','bin','executor']) {
    for (const path of filesUnder(root).filter(executableConfigFile)) {
      if (path==='scripts/proof-live.sh') continue;
      assert.doesNotMatch(read(path),/\bGH_TOKEN\b/,path+' must use GITHUB_TOKEN, not GH_TOKEN');
    }
  }
});
