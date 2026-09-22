import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {GitOvercenterKernel} from '../src/storage/git-kernel.ts';
import {
  advanceProjectForAgent,
  submitProjectCandidate,
} from '../src/authority/project-agent-protocol.ts';

const AUTHORITY_REF='refs/overcenter/test-project-agent';

function git(cwd:string,args:string[]):string {
  return execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
}

function fixture():{
  root:string;
  work:string;
  sourceSha:string;
  postconditionRoot:string;
  postconditionPath:string;
} {
  const root=mkdtempSync(join(tmpdir(),'overcenter-project-agent-'));
  const work=join(root,'work');
  const remote=join(root,'remote.git');
  mkdirSync(work);

  execFileSync('git',['init','--bare',remote],{stdio:'ignore'});
  execFileSync('git',['-C',work,'init','--initial-branch=main'],{stdio:'ignore'});
  execFileSync('git',['-C',work,'config','user.name','Overcenter Test'],{stdio:'ignore'});
  execFileSync('git',['-C',work,'config','user.email','overcenter-test@local'],{stdio:'ignore'});
  writeFileSync(
    join(work,'task.mjs'),
    "import fs from 'node:fs';\nconst input=fs.readFileSync(process.argv[2],'utf8').trim();\nfs.writeFileSync(process.argv[3],'completed:'+input+'\\n');\n",
  );
  writeFileSync(join(work,'input.txt'),'hello\n');
  execFileSync('git',['-C',work,'add','.'],{stdio:'ignore'});
  execFileSync('git',['-C',work,'commit','-m','seed task source'],{stdio:'ignore'});
  execFileSync('git',['-C',work,'remote','add','origin',remote],{stdio:'ignore'});
  execFileSync('git',['-C',work,'push','-u','origin','main'],{stdio:'ignore'});

  const sourceSha=git(work,['rev-parse','HEAD']);
  const postconditionRoot=join('/tmp',`overcenter-agent-${randomUUID()}`);
  const postconditionPath=join(postconditionRoot,'result.txt');
  return {root,work,sourceSha,postconditionRoot,postconditionPath};
}

function commandContext(sourceSha:string,runId=9001) {
  return {
    repository_id:42,
    repository_full_name:'acme/widget',
    command_source_sha:sourceSha,
    command_run_id:runId,
    command_run_attempt:2,
  };
}

function workerClientFixture(root:string):string {
  const path=join(root,'native-overcenter');
  writeFileSync(path,Buffer.from([0x7f,0x45,0x4c,0x46,0x00,0x01,0x02,0x03]));
  return path;
}

function defineAgentWork(
  work:string,
  sourceSha:string,
  postconditionPath:string,
):GitOvercenterKernel {
  const kernel=new GitOvercenterKernel(work,{remote:'origin',ref:AUTHORITY_REF});
  kernel.initialize();
  kernel.define({
    id:'real-frontier-work',
    packet:{
      schema:'overcenter-agent-task/v1',
      kind:'pure-candidate',
      source_sha:sourceSha,
      command:['node','task.mjs','input.txt','result.txt'],
      required_paths:['task.mjs','input.txt'],
      output_path:'result.txt',
    },
    postcondition:{
      verifier:'file-content-equals/v1',
      path:postconditionPath,
      content:'completed:hello\n',
    },
  });
  return kernel;
}

test('project.advance selects and claims real READY work, then emits a bounded packet',()=>{
  const f=fixture();
  try {
    defineAgentWork(f.work,f.sourceSha,f.postconditionPath);
    const outputDir=join(f.root,'packet');
    const receipt=advanceProjectForAgent(
      f.work,
      commandContext(f.sourceSha),
      {
        outputDir,
        workerClientPath:workerClientFixture(f.root),
        authorityRef:AUTHORITY_REF,
        remote:'origin',
      },
    );

    assert.equal(receipt.state,'AGENT_EXECUTION_REQUIRED');
    assert.equal(receipt.obligation_id,'real-frontier-work');
    assert.ok(receipt.run_id);
    assert.ok(receipt.claimed_revision);
    assert.match(receipt.assignment_sha256??'',/^[0-9a-f]{64}$/);
    assert.equal(receipt.candidate_branch,`overcenter/candidate/${receipt.run_id}`);
    assert.equal(receipt.candidate_branch_base_sha,f.sourceSha);

    const assignmentBytes=readFileSync(join(outputDir,'assignment.json'));
    const assignment=JSON.parse(assignmentBytes.toString('utf8'));
    assert.equal(assignment.work.id,'real-frontier-work');
    assert.equal(assignment.work.status,'EXECUTING');
    assert.equal(assignment.work.run_id,receipt.run_id);
    assert.equal(assignmentBytes.includes(Buffer.from('execution_capability')),false);
    assert.deepEqual(
      assignment.files.map((file:{path:string})=>file.path),
      ['task.mjs','input.txt'],
    );
    const workerClient=join(outputDir,'overcenter');
    assert.ok((statSync(workerClient).mode & 0o111)!==0);
    assert.deepEqual(
      readFileSync(workerClient),
      Buffer.from([0x7f,0x45,0x4c,0x46,0x00,0x01,0x02,0x03]),
    );

    const current=new GitOvercenterKernel(
      f.work,
      {remote:'origin',ref:AUTHORITY_REF},
    ).inspect();
    assert.equal(current.length,1,'project.advance must not manufacture request obligations');
    assert.equal(current[0].id,'real-frontier-work');
    assert.equal(current[0].status,'EXECUTING');
    assert.equal(current[0].run_id,receipt.run_id);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
    rmSync(f.postconditionRoot,{recursive:true,force:true});
  }
});

test('unsupported READY work fails before authority is claimed',()=>{
  const f=fixture();
  try {
    const kernel=new GitOvercenterKernel(f.work,{remote:'origin',ref:AUTHORITY_REF});
    kernel.initialize();
    kernel.define({
      id:'deterministic-effect',
      packet:{schema:'provider-effect/v1',kind:'provider-effect'},
      postcondition:{
        verifier:'file-content-equals/v1',
        path:f.postconditionPath,
        content:'done\n',
      },
    });
    const before=kernel.head();

    assert.throws(
      ()=>advanceProjectForAgent(
        f.work,
        commandContext(f.sourceSha),
        {outputDir:join(f.root,'packet'),authorityRef:AUTHORITY_REF,remote:'origin'},
      ),
      /PROJECT_ADVANCE_AGENT_PACKET_UNSUPPORTED/,
    );

    const after=new GitOvercenterKernel(
      f.work,
      {remote:'origin',ref:AUTHORITY_REF},
    );
    assert.equal(after.head(),before);
    assert.equal(after.inspect()[0].status,'READY');
  } finally {
    rmSync(f.root,{recursive:true,force:true});
    rmSync(f.postconditionRoot,{recursive:true,force:true});
  }
});

test('project.submit validates exact packet identity and settles independently',()=>{
  const f=fixture();
  try {
    defineAgentWork(f.work,f.sourceSha,f.postconditionPath);
    const outputDir=join(f.root,'packet');
    const acquired=advanceProjectForAgent(
      f.work,
      commandContext(f.sourceSha),
      {
        outputDir,
        workerClientPath:workerClientFixture(f.root),
        authorityRef:AUTHORITY_REF,
        remote:'origin',
      },
    );
    assert.equal(acquired.state,'AGENT_EXECUTION_REQUIRED');
    assert.ok(acquired.run_id);
    assert.ok(acquired.claimed_revision);
    assert.ok(acquired.assignment_sha256);

    const output=Buffer.from('completed:hello\n');
    const candidate={
      schema:'overcenter-agent-candidate/v1',
      assignment_sha256:acquired.assignment_sha256,
      obligation_id:acquired.obligation_id,
      run_id:acquired.run_id,
      claimed_revision:acquired.claimed_revision,
      output_path:'result.txt',
      output_sha256:createHash('sha256').update(output).digest('hex'),
      output_base64:output.toString('base64'),
    };
    mkdirSync(join(f.work,'.overcenter'),{recursive:true});
    writeFileSync(
      join(f.work,'.overcenter','candidate.json'),
      `${JSON.stringify(candidate,null,2)}\n`,
    );
    execFileSync('git',['-C',f.work,'add','.overcenter/candidate.json'],{stdio:'ignore'});
    execFileSync('git',['-C',f.work,'commit','-m','candidate bytes'],{stdio:'ignore'});
    const candidateSha=git(f.work,['rev-parse','HEAD']);

    const settled=submitProjectCandidate(
      f.work,
      {
        ...commandContext(f.sourceSha,9002),
        candidate_sha:candidateSha,
      },
      {authorityRef:AUTHORITY_REF,remote:'origin'},
    );
    assert.equal(settled.disposition,'DONE');
    assert.equal(settled.verified,true);
    assert.equal(settled.already_settled,false);
    assert.equal(settled.run_id,acquired.run_id);
    assert.ok(settled.settlement_commit);

    const current=new GitOvercenterKernel(
      f.work,
      {remote:'origin',ref:AUTHORITY_REF},
    ).inspect();
    assert.equal(current[0].status,'DONE');

    const replay=submitProjectCandidate(
      f.work,
      {
        ...commandContext(f.sourceSha,9003),
        candidate_sha:candidateSha,
      },
      {authorityRef:AUTHORITY_REF,remote:'origin'},
    );
    assert.equal(replay.disposition,'DONE');
    assert.equal(replay.verified,true);
    assert.equal(replay.already_settled,true);
    assert.equal(replay.settlement_commit,settled.settlement_commit);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
    rmSync(f.postconditionRoot,{recursive:true,force:true});
  }
});

test('project.advance reports DONE for an empty authoritative graph',()=>{
  const f=fixture();
  try {
    const kernel=new GitOvercenterKernel(f.work,{remote:'origin',ref:AUTHORITY_REF});
    kernel.initialize();
    const receipt=advanceProjectForAgent(
      f.work,
      commandContext(f.sourceSha),
      {outputDir:join(f.root,'packet'),authorityRef:AUTHORITY_REF,remote:'origin'},
    );
    assert.equal(receipt.state,'DONE');
    assert.equal(receipt.run_id,undefined);
  } finally {
    rmSync(f.root,{recursive:true,force:true});
    rmSync(f.postconditionRoot,{recursive:true,force:true});
  }
});
