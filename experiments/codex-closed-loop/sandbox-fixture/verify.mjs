import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';

function walk(dir) {
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry => {
    const path=join(dir,entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const remaining=walk(new URL('./src',import.meta.url)).filter(path=>path.endsWith('.js'));
assert.deepEqual(remaining,[],'production JavaScript remains');

const mod=await import('./src/index.ts');
assert.equal(mod.add(2,5),7);
assert.equal(mod.clamp(12,0,10),10);
assert.equal(mod.clamp(-2,0,10),0);
assert.equal(mod.formatUser({name:'Ada Lovelace',email:'ada@example.test'}),'Ada Lovelace <ada@example.test>');
assert.equal(mod.initials('  Grace   Brewster Murray Hopper '),'GBMH');
console.log('synthetic objective verified');
