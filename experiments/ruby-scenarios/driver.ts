import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';

type Dependency =
  | { kind:'control'; upstream:string }
  | {
      kind:'semantic';
      upstream:string;
      consumes:{ kind:'output'; selector:'verified-content' };
    };

type FileObligation = {
  id:string;
  content:string;
  dependencies?:Dependency[];
  packet?:Record<string,unknown>;
};

type Operation =
  | ({ op:'define' } & FileObligation)
  | ({ op:'amend' } & FileObligation)
  | { op:'settle'; id:string }
  | { op:'checkpoint'; name:string }
  | { op:'reconstruct'; name:string };

type Script = {
  scenario:string;
  operations:Operation[];
};

const STATE_REF='refs/overcenter/state';

function git(repo:string,args:string[]) {
  return execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
}

function obligation(root:string,input:FileObligation) {
  return {
    id:input.id,
    packet:input.packet??{},
    dependencies:input.dependencies??[],
    postcondition:{
      verifier:'file-content-equals/v1' as const,
      path:join(root,`${input.id}.txt`),
      content:input.content,
    },
  };
}

function settle(root:string,kernel:GitOvercenterKernel,id:string) {
  const work=kernel.inspect().find(candidate=>candidate.id===id);
  if (!work) throw new Error(`UNKNOWN_WORK:${id}`);
  if (work.status!=='READY') {
    throw new Error(`NOT_READY:${id}:${work.status}`);
  }
  if (work.postcondition.verifier!=='file-content-equals/v1') {
    throw new Error(`UNSUPPORTED_POSTCONDITION:${id}`);
  }

  const run=kernel.claim(id,work.revision);
  kernel.beginEffect(run);
  writeFileSync(work.postcondition.path,work.postcondition.content);
  const receipt=kernel.resolve(run);
  if (receipt.disposition!=='DONE') {
    throw new Error(`SETTLEMENT_FAILED:${id}:${receipt.disposition}`);
  }
}

function freshProjection(root:string,authority:string,index:number) {
  const replica=join(root,`replica-${index}.git`);
  execFileSync('git',['init','--bare',replica],{stdio:'ignore'});
  git(replica,['remote','add','origin',authority]);
  git(replica,['fetch','--no-tags','origin',`+${STATE_REF}:${STATE_REF}`]);
  return new GitOvercenterKernel(replica,{remote:'origin'}).inspect();
}

const input=JSON.parse(readFileSync(0,'utf8')) as Script;
const root=mkdtempSync(join(tmpdir(),'overcenter-ruby-scenario-'));
const authority=join(root,'authority.git');
const checkpoints:Record<string,unknown>={};
let replicaIndex=0;

try {
  execFileSync('git',['init','--bare',authority],{stdio:'ignore'});
  const kernel=new GitOvercenterKernel(authority);
  kernel.initialize();

  for (const operation of input.operations) {
    switch (operation.op) {
      case 'define':
        kernel.define(obligation(root,operation));
        break;
      case 'amend':
        kernel.amend(obligation(root,operation),kernel.head()!);
        break;
      case 'settle':
        settle(root,kernel,operation.id);
        break;
      case 'checkpoint':
        checkpoints[operation.name]=kernel.inspect();
        break;
      case 'reconstruct':
        replicaIndex+=1;
        checkpoints[operation.name]=freshProjection(root,authority,replicaIndex);
        break;
      default: {
        const exhaustive:never=operation;
        throw new Error(`UNKNOWN_OPERATION:${JSON.stringify(exhaustive)}`);
      }
    }
  }

  process.stdout.write(JSON.stringify({
    scenario:input.scenario,
    checkpoints,
  }));
} finally {
  rmSync(root,{recursive:true,force:true});
}
