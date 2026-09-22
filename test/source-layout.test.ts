import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
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
