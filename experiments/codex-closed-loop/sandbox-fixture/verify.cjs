const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {readdirSync,writeSync}=require('node:fs');
const {join}=require('node:path');

function walk(dir) {
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry => {
    const path=join(dir,entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const sourceRoot=join(__dirname,'src');
const remaining=walk(sourceRoot).filter(path=>path.endsWith('.js'));
assert.deepEqual(remaining,[],'production JavaScript remains');

const moduleUrl=process.argv[2];
assert.match(moduleUrl??'',/^data:text\/javascript;base64,[A-Za-z0-9+/=]+$/);

const nonce=randomBytes(32).toString('hex');
const emit=writeSync;
const VerificationError=Error;
const requireEqual=(label,actual,expected)=>{
  if (actual!==expected) {
    throw new VerificationError(`CANDIDATE_VERIFICATION_MISMATCH:${label}`);
  }
};

emit(1,`OVERCENTER_VERIFY_CHALLENGE ${nonce}\n`);

import(moduleUrl).then(mod=>{
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
}).catch(error=>{
  process.stderr.write(String(error?.stack??error)+'\n');
  process.exitCode=1;
});
