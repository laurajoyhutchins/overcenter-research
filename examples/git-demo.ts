import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOvercenterKernel } from '../src/git-kernel.ts';

const root=mkdtempSync(join(tmpdir(),'overcenter-git-demo-'));
const repo=join(root,'state.git');
const file=join(root,'artifact.txt');
const build=join(root,'build.txt');

execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
const kernel=new GitOvercenterKernel(repo);
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

console.log('state ref before:',kernel.head());
console.log('before:',kernel.inspect().map(({id,status})=>({id,status})));

// Demo-only world materialization. The Git kernel is a reference authority
// backend, not a provider-mutation dispatcher.
writeFileSync(file,'file-exists');
const first=kernel.deriveReadyWork();
if (!first || first.id!=='observe-file') throw new Error('FIRST_WORK_NOT_READY');
kernel.resolve(kernel.claim(first.id,first.revision));

writeFileSync(build,'build-passes');
const second=kernel.deriveReadyWork();
if (!second || second.id!=='observe-build') throw new Error('SECOND_WORK_NOT_READY');
kernel.resolve(kernel.claim(second.id,second.revision));

console.log('state ref after:',kernel.head());
console.log('after:',kernel.inspect().map(({id,status})=>({id,status})));
console.log('receipt commits:',kernel.receipts().map(({obligation_id,disposition,settlement_commit})=>({
  obligation_id,disposition,settlement_commit,
})));
console.log('history:');
console.log(execFileSync(
  'git',
  ['-C',repo,'log','--reverse','--oneline','refs/overcenter/state'],
  {encoding:'utf8'},
).trim());

rmSync(root,{recursive:true,force:true});
