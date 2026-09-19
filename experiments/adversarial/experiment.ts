import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import type { ExecutionPermit, Work } from '../../src/model.ts';
import type { ObligationInput } from '../../src/facts.ts';

const STATE_REF='refs/overcenter/state';

export type Dependency=NonNullable<ObligationInput['dependencies']>[number];

export const semantic=(upstream:string):Dependency=>({
  kind:'semantic',
  upstream,
  consumes:{kind:'output',selector:'verified-content'},
});

export const control=(upstream:string):Dependency=>({
  kind:'control',
  upstream,
});

export class Experiment {
  readonly root:string;
  readonly authority:string;
  readonly kernel:GitOvercenterKernel;
  #replica=0;

  constructor() {
    this.root=mkdtempSync(join(tmpdir(),'overcenter-experiment-'));
    this.authority=join(this.root,'authority.git');
    execFileSync('git',['init','--bare',this.authority],{stdio:'ignore'});
    this.kernel=new GitOvercenterKernel(this.authority);
    this.kernel.initialize();
  }

  path(id:string):string {
    return join(this.root,`${id}.txt`);
  }

  define(
    id:string,
    {
      content,
      packet={},
      dependencies=[],
      consistency='strong',
    }:{
      content:string;
      packet?:Record<string,unknown>;
      dependencies?:Dependency[];
      consistency?:'strong'|'eventual';
    },
  ):string {
    return this.kernel.define({
      id,
      packet,
      dependencies,
      postcondition:{
        verifier:consistency==='eventual'
          ? 'eventually-consistent-file-content-equals/v1'
          : 'file-content-equals/v1',
        path:this.path(id),
        content,
      },
    });
  }

  amend(
    id:string,
    {
      content,
      packet={},
      dependencies=[],
      consistency='strong',
    }:{
      content:string;
      packet?:Record<string,unknown>;
      dependencies?:Dependency[];
      consistency?:'strong'|'eventual';
    },
  ):string {
    return this.kernel.amend({
      id,
      packet,
      dependencies,
      postcondition:{
        verifier:consistency==='eventual'
          ? 'eventually-consistent-file-content-equals/v1'
          : 'file-content-equals/v1',
        path:this.path(id),
        content,
      },
    },this.kernel.head()!);
  }

  work(id:string,snapshot:Work[]=this.kernel.inspect()):Work {
    const work=snapshot.find(candidate=>candidate.id===id);
    if (!work) throw new Error(`UNKNOWN_WORK:${id}`);
    return work;
  }

  settle(id:string):ExecutionPermit {
    const work=this.work(id);
    if (work.status!=='READY') throw new Error(`NOT_READY:${id}:${work.status}`);
    if (
      work.postcondition.verifier!=='file-content-equals/v1'
      && work.postcondition.verifier!=='eventually-consistent-file-content-equals/v1'
    ) throw new Error(`UNSUPPORTED_EXPERIMENT_POSTCONDITION:${id}`);

    const permit=this.kernel.claim(id,work.revision);
    this.kernel.beginEffect(permit);
    writeFileSync(work.postcondition.path,work.postcondition.content);
    const receipt=this.kernel.resolve(permit);
    if (receipt.disposition!=='DONE') {
      throw new Error(`SETTLEMENT_FAILED:${id}:${receipt.disposition}`);
    }
    return permit;
  }

  claim(id:string):ExecutionPermit {
    const work=this.work(id);
    if (work.status!=='READY') throw new Error(`NOT_READY:${id}:${work.status}`);
    return this.kernel.claim(id,work.revision);
  }

  write(id:string,content:string):void {
    writeFileSync(this.path(id),content);
  }

  snapshot():Work[] {
    return this.kernel.inspect();
  }

  reconstruct():Work[] {
    this.#replica+=1;
    const repo=join(this.root,`replica-${this.#replica}.git`);
    execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
    execFileSync('git',['-C',repo,'remote','add','origin',this.authority],{stdio:'ignore'});
    execFileSync(
      'git',
      ['-C',repo,'fetch','--no-tags','origin',`+${STATE_REF}:${STATE_REF}`],
      {stdio:'ignore'},
    );
    return new GitOvercenterKernel(repo,{remote:'origin'}).inspect();
  }

  close():void {
    rmSync(this.root,{recursive:true,force:true});
  }
}
