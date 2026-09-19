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
import { runProviderObservationCase, type ScenarioObservation, type ScenarioProvider } from './provider-fixtures.ts';

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
  consistency?:'strong'|'eventual';
  dependencies?:Dependency[];
  packet?:Record<string,unknown>;
};

type Operation =
  | ({ op:'define' } & FileObligation)
  | ({ op:'amend' } & FileObligation)
  | { op:'settle'; id:string }
  | { op:'claim'; id:string; name:string }
  | { op:'renew-execution'; permit:string; name:string }
  | { op:'reserve-effect'; permit:string; name:string }
  | { op:'provider-observe'; provider:ScenarioProvider; event:ScenarioObservation; name:string }
  | { op:'provider-effect'; id:string }
  | { op:'interrupt'; id:string }
  | {
      op:'readback';
      id:string;
      name:string;
      state:'missing'|'expected'|'value';
      value?:string;
    }
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
  const path=join(root,`${input.id}.txt`);
  return {
    id:input.id,
    packet:input.packet??{},
    dependencies:input.dependencies??[],
    postcondition:input.consistency==='eventual'
      ? {
          verifier:'eventually-consistent-file-content-equals/v1' as const,
          path,
          content:input.content,
        }
      : {
          verifier:'file-content-equals/v1' as const,
          path,
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
const readbacks:Record<string,unknown>={};
const runs=new Map<string,ReturnType<GitOvercenterKernel['claim']>>();
const permits=new Map<string,ReturnType<GitOvercenterKernel['claim']>>();
const outcomes:Record<string,unknown>={};
const effectAttempts:Record<string,number>={};
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
      case 'claim': {
        const work=kernel.inspect().find(candidate=>candidate.id===operation.id);
        if (!work) throw new Error(`UNKNOWN_WORK:${operation.id}`);
        if (work.status!=='READY') throw new Error(`NOT_READY:${operation.id}:${work.status}`);
        permits.set(operation.name,kernel.claim(operation.id,work.revision));
        break;
      }
      case 'renew-execution': {
        const permit=permits.get(operation.permit);
        if (!permit) throw new Error(`UNKNOWN_PERMIT:${operation.permit}`);
        permits.set(operation.name,kernel.acquireExecution(permit.id));
        break;
      }
      case 'reserve-effect': {
        const permit=permits.get(operation.permit);
        if (!permit) throw new Error(`UNKNOWN_PERMIT:${operation.permit}`);
        try {
          kernel.beginEffect(permit);
          outcomes[operation.name]={ok:true};
        } catch (error:unknown) {
          outcomes[operation.name]={
            ok:false,
            error:error instanceof Error?error.message:String(error),
          };
        }
        break;
      }
      case 'provider-observe': {
        const result=runProviderObservationCase(operation.provider,operation.event);
        readbacks[operation.name]=result.receipt;
        checkpoints[operation.name]=[result.work];
        break;
      }
      case 'provider-effect': {
        const work=kernel.inspect().find(candidate=>candidate.id===operation.id);
        if (!work) throw new Error(`UNKNOWN_WORK:${operation.id}`);
        if (work.status!=='READY') {
          throw new Error(`NOT_READY:${operation.id}:${work.status}`);
        }
        if (work.postcondition.verifier!=='eventually-consistent-file-content-equals/v1') {
          throw new Error(`NOT_EVENTUAL_PROVIDER:${operation.id}`);
        }
        const run=kernel.claim(operation.id,work.revision);
        kernel.beginEffect(run);
        runs.set(operation.id,run);
        effectAttempts[operation.id]=(effectAttempts[operation.id]??0)+1;
        writeFileSync(
          join(root,`${operation.id}.provider-truth.json`),
          JSON.stringify({accepted:true,attempt:effectAttempts[operation.id]}),
        );
        break;
      }
      case 'interrupt': {
        const run=runs.get(operation.id);
        if (!run) throw new Error(`NO_ACTIVE_PROVIDER_RUN:${operation.id}`);
        kernel.recoverInterrupted(run,{source:'ruby-hostile-provider-scenario'});
        break;
      }
      case 'readback': {
        const run=runs.get(operation.id);
        if (!run) throw new Error(`NO_ACTIVE_PROVIDER_RUN:${operation.id}`);
        const work=kernel.inspect().find(candidate=>candidate.id===operation.id);
        if (!work) throw new Error(`UNKNOWN_WORK:${operation.id}`);
        if (work.postcondition.verifier!=='eventually-consistent-file-content-equals/v1') {
          throw new Error(`NOT_EVENTUAL_PROVIDER:${operation.id}`);
        }

        if (operation.state==='missing') {
          rmSync(work.postcondition.path,{force:true});
        } else if (operation.state==='expected') {
          writeFileSync(work.postcondition.path,work.postcondition.content);
        } else {
          writeFileSync(work.postcondition.path,operation.value??'');
        }

        const receipt=kernel.reconcile(run);
        readbacks[operation.name]=receipt;
        checkpoints[operation.name]=kernel.inspect();
        break;
      }
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

  const receipts=Object.fromEntries(
    [...runs.entries()].map(([id,run])=>[
      id,
      kernel.receipts(run.id).map(receipt=>receipt.disposition),
    ]),
  );

  process.stdout.write(JSON.stringify({
    scenario:input.scenario,
    checkpoints,
    readbacks,
    effect_attempts:effectAttempts,
    outcomes,
    receipts,
  }));
} finally {
  rmSync(root,{recursive:true,force:true});
}
