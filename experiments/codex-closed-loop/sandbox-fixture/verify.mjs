import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readdirSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

function walk(dir) {
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry => {
    const path=join(dir,entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const sourceRoot=fileURLToPath(new URL('./src',import.meta.url));
const remaining=walk(sourceRoot).filter(path=>path.endsWith('.js'));
assert.deepEqual(remaining,[],'production JavaScript remains');

const nonce=randomBytes(32).toString('hex');
const emit=writeSync;
const VerificationError=Error;
const requireEqual=(label,actual,expected)=>{
  if (actual!==expected) {
    throw new VerificationError(`CANDIDATE_VERIFICATION_MISMATCH:${label}`);
  }
};

emit(1,`OVERCENTER_VERIFY_CHALLENGE ${nonce}\n`);

const mod=await import('./src/index.ts');
requireEqual('add-positive',mod.add(2,5),7);
requireEqual('add-mixed',mod.add(-4,9),5);
requireEqual('clamp-high',mod.clamp(12,0,10),10);
requireEqual('clamp-low',mod.clamp(-2,0,10),0);
requireEqual('clamp-mid',mod.clamp(5,0,10),5);
requireEqual(
  'format-ada',
  mod.formatUser({name:'Ada Lovelace',email:'ada@example.test'}),
  'Ada Lovelace <ada@example.test>',
);
requireEqual(
  'format-grace',
  mod.formatUser({name:'Grace Hopper',email:'grace@example.test'}),
  'Grace Hopper <grace@example.test>',
);
requireEqual('initials-grace',mod.initials('  Grace   Brewster Murray Hopper '),'GBMH');
requireEqual('initials-ada',mod.initials('ada lovelace'),'AL');

emit(1,`OVERCENTER_VERIFY_COMPLETE ${nonce}\n`);
