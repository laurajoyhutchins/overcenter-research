import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OvercenterKernel,
  runCoreLoop,
} from '../src/kernel.ts';

const root=mkdtempSync(join(tmpdir(),'overcenter-sqlite-demo-'));
const database=join(root,'overcenter.sqlite');
const file=join(root,'artifact.txt');
const build=join(root,'build.txt');

const kernel=new OvercenterKernel(database);
kernel.initialize();

kernel.define({
  id:'write-file',
  packet:{path:file,content:'file-exists'},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:file,
    content:'file-exists',
  },
});
kernel.define({
  id:'verify-build',
  dependencies:[{kind:'control',upstream:'write-file'}],
  packet:{path:build,content:'build-passes'},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:build,
    content:'build-passes',
  },
});

console.log('authority before:',kernel.head());
console.log(
  'before:',
  kernel.inspect().map(({id,status})=>({id,status})),
);

const result=await runCoreLoop(kernel,{
  effect:async packet=>{
    writeFileSync(String(packet.path),String(packet.content));
    return {kind:'ok'};
  },
});

console.log('loop:',result);
console.log('authority after:',kernel.head());
console.log(
  'after:',
  kernel.inspect().map(({id,status})=>({id,status})),
);
console.log(
  'receipts:',
  kernel.receipts().map(({
    obligation_id,
    disposition,
    settlement_commit,
  })=>({
    obligation_id,
    disposition,
    settlement_commit,
  })),
);

const expected=kernel.inspect();
kernel.close();

const fresh=new OvercenterKernel(database);
console.log(
  'reopened:',
  fresh.inspect().map(({id,status})=>({id,status})),
);
if (JSON.stringify(fresh.inspect())!==JSON.stringify(expected)) {
  throw new Error('SQLITE_RECONSTRUCTION_MISMATCH');
}
fresh.close();

rmSync(root,{recursive:true,force:true});
