import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OvercenterKernel } from '../src/kernel.ts';

const root=mkdtempSync(join(tmpdir(),'overcenter-sqlite-demo-'));
const database=join(root,'overcenter.sqlite');
const file=join(root,'artifact.txt');
const build=join(root,'build.txt');

const kernel=new OvercenterKernel(database);
kernel.initialize();

kernel.define({
  id:'observe-file',
  postcondition:{verifier:'file-content-equals/v1',path:file,content:'file-exists'},
});
kernel.define({
  id:'observe-build',
  dependencies:[{kind:'control',upstream:'observe-file'}],
  postcondition:{verifier:'file-content-equals/v1',path:build,content:'build-passes'},
});

console.log('authority before:',kernel.head());
console.log('before:',kernel.inspect().map(({id,status})=>({id,status})));

// Demo-only world materialization. Production mutation is deliberately absent
// from the kernel API and must use an explicit authorized broker.
writeFileSync(file,'file-exists');
const first=kernel.deriveReadyWork();
if (!first || first.id!=='observe-file') throw new Error('FIRST_WORK_NOT_READY');
kernel.resolve(kernel.claim(first.id,first.revision));

writeFileSync(build,'build-passes');
const second=kernel.deriveReadyWork();
if (!second || second.id!=='observe-build') throw new Error('SECOND_WORK_NOT_READY');
kernel.resolve(kernel.claim(second.id,second.revision));

console.log('authority after:',kernel.head());
console.log('after:',kernel.inspect().map(({id,status})=>({id,status})));
console.log('receipts:',kernel.receipts().map(({obligation_id,disposition,settlement_commit})=>({
  obligation_id,disposition,settlement_commit,
})));

const expected=kernel.inspect();
kernel.close();

const fresh=new OvercenterKernel(database);
console.log('reopened:',fresh.inspect().map(({id,status})=>({id,status})));
if (JSON.stringify(fresh.inspect())!==JSON.stringify(expected)) {
  throw new Error('SQLITE_RECONSTRUCTION_MISMATCH');
}
fresh.close();
rmSync(root,{recursive:true,force:true});
