import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
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
    mkdirSync(work);
    const archive=execFileSync('git',['archive','--format=tar','HEAD'],{maxBuffer:64*1024*1024});
    const extracted=spawnSync('tar',['-xf','-','-C',work],{input:archive});
    assert.equal(extracted.status,0,extracted.stderr?.toString('utf8'));

    execFileSync('git',['-C',work,'init','--initial-branch=main'],{stdio:'ignore'});
    execFileSync('git',['-C',work,'config','user.name','Overcenter Test'],{stdio:'ignore'});
    execFileSync('git',['-C',work,'config','user.email','overcenter-test@local'],{stdio:'ignore'});
    execFileSync('git',['-C',work,'add','.'],{stdio:'ignore'});
    execFileSync('git',['-C',work,'commit','-m','seed ingress test repository'],{stdio:'ignore'});

    execFileSync('git',['init','--bare',remote],{stdio:'ignore'});
    execFileSync('git',['-C',work,'remote','add','origin',remote],{stdio:'ignore'});
    execFileSync('git',['-C',work,'push','-u','origin','main'],{stdio:'ignore'});
    const sourceSha=execFileSync('git',['-C',work,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const env={
      REQUEST_ID:'4242424242424242424242424242424242424242',
      SOURCE_SHA:sourceSha,
      OVERCENTER_INGRESS_REMOTE:'origin',
      OVERCENTER_INGRESS_AUTHORITY_REF:'refs/overcenter/test-agent-ingress',
    };

    const first=run(work,env,'capsule-1','receipt-1.json');
    const second=run(work,env,'capsule-2','receipt-2.json');

    assert.equal(first.obligation_id,'github-agent-ingress-4242424242424242424242424242424242424242');
    assert.equal(first.run_id,second.run_id);
    assert.equal(first.claimed_revision,second.claimed_revision);
    assert.equal(first.assignment_sha256,second.assignment_sha256);
    assert.equal(first.authority_head,second.authority_head);

    const assignment=readFileSync(join(work,'capsule-2','assignment.json'));
    assert.equal(assignment.includes(Buffer.from('execution_capability')),false);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('candidate submit settles once and replays the same verified receipt',()=>{
  const root=mkdtempSync(join(tmpdir(),'overcenter-agent-submit-'));
  try {
    const remote=join(root,'remote.git');
    const work=join(root,'work');
    mkdirSync(work);
    const archive=execFileSync('git',['archive','--format=tar','HEAD'],{maxBuffer:64*1024*1024});
    const extracted=spawnSync('tar',['-xf','-','-C',work],{input:archive});
    assert.equal(extracted.status,0,extracted.stderr?.toString('utf8'));

    execFileSync('git',['-C',work,'init','--initial-branch=main'],{stdio:'ignore'});
    execFileSync('git',['-C',work,'config','user.name','Overcenter Test'],{stdio:'ignore'});
    execFileSync('git',['-C',work,'config','user.email','overcenter-test@local'],{stdio:'ignore'});
    execFileSync('git',['-C',work,'add','.'],{stdio:'ignore'});
    execFileSync('git',['-C',work,'commit','-m','seed silent mailbox test repository'],{stdio:'ignore'});
    execFileSync('git',['init','--bare',remote],{stdio:'ignore'});
    execFileSync('git',['-C',work,'remote','add','origin',remote],{stdio:'ignore'});
    execFileSync('git',['-C',work,'push','-u','origin','main'],{stdio:'ignore'});

    const sourceSha=execFileSync('git',['-C',work,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const acquireId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const authorityRef='refs/overcenter/test-agent-submit';
    const baseEnv={
      SOURCE_SHA:sourceSha,
      OVERCENTER_INGRESS_REMOTE:'origin',
      OVERCENTER_INGRESS_AUTHORITY_REF:authorityRef,
    };
    const acquired=run(
      work,
      {...baseEnv,REQUEST_ID:acquireId},
      'capsule',
      'acquire-receipt.json',
    );

    mkdirSync(join(work,'candidate-workspace'));
    mkdirSync(join(work,'candidate-home'));
    execFileSync(
      'sudo',
      [
        '/usr/bin/unshare',
        '--net',
        '--fork',
        '/usr/bin/env',
        '-i',
        `PATH=${process.env.PATH??'/usr/local/bin:/usr/bin:/bin'}`,
        `HOME=${join(work,'candidate-home')}`,
        'node',
        join(work,'capsule','assignment-capsule.ts'),
        'run',
        join(work,'capsule','assignment.json'),
        join(work,'candidate-workspace'),
        join(work,'candidate.json'),
      ],
      {cwd:work,stdio:'pipe'},
    );
    mkdirSync(join(work,'.overcenter'),{recursive:true});
    writeFileSync(
      join(work,'.overcenter','candidate.json'),
      readFileSync(join(work,'candidate.json')),
    );
    execFileSync('git',['-C',work,'add','.overcenter/candidate.json'],{stdio:'ignore'});
    execFileSync('git',['-C',work,'commit','-m','candidate'],{stdio:'ignore'});
    const candidateSha=execFileSync(
      'git',
      ['-C',work,'rev-parse','HEAD'],
      {encoding:'utf8'},
    ).trim();

    const submitId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const submitEnv={
      ...baseEnv,
      REQUEST_ID:submitId,
      TARGET_REQUEST_SHA:acquireId,
      CANDIDATE_SHA:candidateSha,
    };
    execFileSync(
      'node',
      ['--experimental-strip-types','bin/github-agent-submit.ts','--receipt','submit-1.json'],
      {cwd:work,env:{...process.env,...submitEnv},stdio:'pipe'},
    );
    const first=JSON.parse(readFileSync(join(work,'submit-1.json'),'utf8'));
    assert.equal(first.request_sha,submitId);
    assert.equal(first.target_request_sha,acquireId);
    assert.equal(first.run_id,acquired.run_id);
    assert.equal(first.disposition,'DONE');
    assert.equal(first.verified,true);
    assert.equal(first.already_settled,false);
    assert.ok(first.settlement_commit);

    execFileSync(
      'node',
      ['--experimental-strip-types','bin/github-agent-submit.ts','--receipt','submit-2.json'],
      {cwd:work,env:{...process.env,...submitEnv},stdio:'pipe'},
    );
    const replay=JSON.parse(readFileSync(join(work,'submit-2.json'),'utf8'));
    assert.equal(replay.disposition,'DONE');
    assert.equal(replay.verified,true);
    assert.equal(replay.already_settled,true);
    assert.equal(replay.settlement_commit,first.settlement_commit);
    assert.equal(replay.output_sha256,first.output_sha256);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('mailbox transport is silent and privileged handling starts at workflow_run',()=>{
  const mailbox=readFileSync('.github/workflows/agent-ingress.yml','utf8');
  const signal=readFileSync('.github/workflows/agent-request-signal.yml','utf8');
  assert.match(mailbox,/workflow_run:/);
  assert.doesNotMatch(mailbox,/issue_comment:/);
  assert.doesNotMatch(mailbox,/issues:\s*write/);
  assert.match(signal,/permissions:\s*\{\}/);
  assert.match(signal,/overcenter\/request\/\*\*/);
  assert.doesNotMatch(signal,/contents:\s*write/);
  assert.equal(mailbox.includes('request_sha="$REQUEST_EVENT_SHA"'),true);
  assert.equal(mailbox.includes('${REQUEST_REF#overcenter/request/}'),false);
});

