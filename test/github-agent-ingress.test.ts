import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

function run(cwd:string,env:Record<string,string>,capsule:string,receipt:string):Record<string,unknown> {
  execFileSync(
    'node',
    ['--experimental-strip-types','bin/github-agent-ingress.ts','--capsule-dir',capsule,'--receipt',receipt],
    {cwd,env:{...process.env,...env},stdio:'pipe'},
  );
  return JSON.parse(readFileSync(join(cwd,receipt),'utf8'));
}

test('duplicate GitHub request reconstructs the same exact claim',()=>{
  const root=mkdtempSync(join(tmpdir(),'overcenter-agent-ingress-'));
  try {
    const remote=join(root,'remote.git');
    const work=join(root,'work');
    execFileSync('git',['clone','--bare','.',remote],{stdio:'ignore'});
    execFileSync('git',['clone',remote,work],{stdio:'ignore'});
    const sourceSha=execFileSync('git',['-C',work,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const env={
      REQUEST_COMMENT_ID:'424242',
      SOURCE_SHA:sourceSha,
      OVERCENTER_INGRESS_REMOTE:'origin',
      OVERCENTER_INGRESS_AUTHORITY_REF:'refs/overcenter/test-agent-ingress',
    };

    const first=run(work,env,'capsule-1','receipt-1.json');
    const second=run(work,env,'capsule-2','receipt-2.json');

    assert.equal(first.obligation_id,'github-agent-ingress-424242');
    assert.equal(first.run_id,second.run_id);
    assert.equal(first.claimed_revision,second.claimed_revision);
    assert.equal(first.assignment_sha256,second.assignment_sha256);
    assert.equal(first.authority_head,second.authority_head);
    assert.equal(first.artifact_name,'overcenter-assignment-424242');

    const assignment=readFileSync(join(work,'capsule-2','assignment.json'));
    assert.equal(assignment.includes(Buffer.from('execution_capability')),false);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
