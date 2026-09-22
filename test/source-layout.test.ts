import assert from 'node:assert/strict';
import {existsSync,readdirSync} from 'node:fs';
import test from 'node:test';

const entries=(path:string)=>readdirSync(path,{withFileTypes:true})
  .map(entry=>`${entry.name}${entry.isDirectory()?'/':''}`)
  .sort();

test('src root exposes only architectural namespaces and cross-cutting primitives',()=>{
  assert.deepEqual(entries('src'),[
    'README.md',
    'authority/',
    'digest.ts',
    'execution/',
    'generated/',
    'graph/',
    'model.ts',
    'observation/',
    'providers/',
    'semantics.ts',
    'storage/',
    'structural-schema.ts',
    'validation.ts',
  ]);
});

test('provider implementations are namespaced by provider',()=>{
  assert.deepEqual(entries('src/providers'),['gcp/','github/','kubernetes/']);
});

test('native execution implementations live beneath the execution namespace',()=>{
  assert.deepEqual(entries('src/execution'),[
    'assignment-capsule.ts',
    'confined-executor.ts',
    'confinement/',
    'containment.ts',
    'context.ts',
    'executor/',
    'go-client.ts',
    'manifest.ts',
    'protocol.ts',
    'runner.ts',
    'worker-client/',
  ]);
  assert.equal(existsSync('executor'),false);
  assert.equal(existsSync('runtime'),false);
});

test('GitHub provider has no App-specific runtime path',()=>{
  for (const path of [
    'src/providers/github/app-webhook-deliveries.ts',
    'src/providers/github/status-webhook.ts',
    'src/providers/github/status-mirror-sqlite.ts',
  ]) {
    assert.equal(existsSync(path),false,`GitHub App runtime coupling returned: ${path}`);
  }
});
