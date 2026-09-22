import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  assignmentFile,
  buildAssignment,
  encodeAssignment,
  materializeAssignment,
  validateAssignment,
  validateCandidate,
} from '../../src/assignment-capsule.ts';

function work() {
  return {
    id:'proof',
    dependencies:[],
    packet:{
      schema:'overcenter-agent-task/v1',
      kind:'pure-candidate',
      source_sha:'1'.repeat(40),
      command:['node','--experimental-strip-types','task.ts','input.txt','result.txt'],
      required_paths:['task.ts','input.txt'],
      output_path:'result.txt',
    },
    postcondition:{verifier:'file-content-equals/v1',path:'/tmp/result.txt',content:'done\n'},
    status:'EXECUTING',
    revision:'head-after-claim',
    run_id:'run-1',
    claimed_revision:'head-before-claim',
    execution_generation:1,
  };
}

const files=()=>[
  assignmentFile('task.ts',Buffer.from('process.exit(0)\n')),
  assignmentFile('input.txt',Buffer.from('payload\n')),
];

test('claimed work plus exact bytes forms a valid self-contained assignment',()=>{
  const assignment=buildAssignment(work(),files());
  const encoded=encodeAssignment(assignment);
  assert.ok(encoded.length>0);
  assert.equal(encoded.includes(Buffer.from('execution_capability')),false);
});

test('one altered byte fails closed before materialization',()=>{
  const assignment=buildAssignment(work(),files());
  assignment.files[1].content_base64=Buffer.from('payloae\n').toString('base64');
  assert.throws(()=>validateAssignment(assignment),/ASSIGNMENT_FILE_DIGEST_MISMATCH/);
});

test('one missing required file fails closed before execution',()=>{
  const assignment=buildAssignment(work(),files());
  assignment.files=assignment.files.filter(file=>file.path!=='input.txt');
  assert.throws(()=>validateAssignment(assignment),/ASSIGNMENT_REQUIRED_FILE_MISSING:input.txt/);
});

test('materialization recreates only declared bytes',()=>{
  const root=mkdtempSync(join(tmpdir(),'assignment-capsule-'));
  try {
    const assignment=buildAssignment(work(),files());
    materializeAssignment(assignment,root);
    assert.equal(readFileSync(join(root,'input.txt'),'utf8'),'payload\n');
    assert.equal(readFileSync(join(root,'task.ts'),'utf8'),'process.exit(0)\n');
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('candidate bytes are bound to the exact assignment and claimed run',()=>{
  const assignment=buildAssignment(work(),files());
  const bytes=encodeAssignment(assignment);
  const output=Buffer.from('done\n');
  const candidate={
    schema:'overcenter-agent-candidate/v1',
    assignment_sha256:createHash('sha256').update(bytes).digest('hex'),
    obligation_id:'proof',
    run_id:'run-1',
    claimed_revision:'head-before-claim',
    output_path:'result.txt',
    output_sha256:createHash('sha256').update(output).digest('hex'),
    output_base64:output.toString('base64'),
  };
  validateCandidate(candidate,assignment,bytes);
  const forged={...candidate,run_id:'run-2'};
  assert.throws(()=>validateCandidate(forged,assignment,bytes),/CANDIDATE_RUN_MISMATCH/);
});

test('hostile path grammar is rejected',()=>{
  for (const bad of ['', '/x','a//b','a/./b','a/../b','a\nb']) {
    const assignment=buildAssignment(work(),files());
    assignment.files[0].path=bad;
    assert.throws(()=>validateAssignment(assignment));
  }
});
