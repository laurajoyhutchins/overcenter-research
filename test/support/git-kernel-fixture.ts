import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import type { Dependency, ExecutionPermit, Work } from '../../src/model.ts';

const STATE_REF='refs/overcenter/state';

type FileSpec={
  content:string;
  packet?:Record<string,unknown>;
  dependencies?:Dependency[];
  consistency?:'strong'|'eventual';
  path?:string;
};

export const verifiedContent=(upstream:string):Dependency=>({
  kind:'semantic',
  upstream,
  consumes:{kind:'output',selector:'verified-content'},
});

export const controlDependency=(upstream:string):Dependency=>({
  kind:'control',
  upstream,
});

export class GitKernelFixture {
  readonly root:string;
  readonly authority:string;
  readonly kernel:GitOvercenterKernel;
  #replica=0;

  constructor(prefix='overcenter-test-') {
    this.root=mkdtempSync(join(tmpdir(),prefix));
    this.authority=join(this.root,'authority.git');
    execFileSync('git',['init','--bare',this.authority],{stdio:'ignore'});
    this.kernel=new GitOvercenterKernel(this.authority);
    this.kernel.initialize();
  }

  path(name:string):string {
    return join(this.root,name);
  }

  git(args:string[],repo=this.authority):string {
    return execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  }

  defineFile(id:string,spec:FileSpec):string {
    return this.kernel.define(this.#obligation(id,spec));
  }

  amendFile(id:string,spec:FileSpec):string {
    return this.kernel.amend(this.#obligation(id,spec),this.kernel.head()!);
  }

  work(id:string,snapshot:Work[]=this.kernel.inspect()):Work {
    const work=snapshot.find(candidate=>candidate.id===id);
    if (!work) throw new Error(`UNKNOWN_WORK:${id}`);
    return work;
  }

  claim(id:string):ExecutionPermit {
    const work=this.work(id);
    if (work.status!=='READY') throw new Error(`NOT_READY:${id}:${work.status}`);
    return this.kernel.claim(id,work.revision);
  }

  settleFile(id:string):ExecutionPermit {
    const work=this.work(id);
    if (
      work.postcondition.verifier!=='file-content-equals/v1'
      && work.postcondition.verifier!=='eventually-consistent-file-content-equals/v1'
    ) throw new Error(`UNSUPPORTED_FILE_POSTCONDITION:${id}`);

    const permit=this.claim(id);
    this.kernel.beginEffect(permit);
    writeFileSync(work.postcondition.path,work.postcondition.content);
    const receipt=this.kernel.reconcile(permit);
    if (receipt.disposition!=='DONE') {
      throw new Error(`SETTLEMENT_FAILED:${id}:${receipt.disposition}`);
    }
    return permit;
  }

  freshKernel():{repo:string;kernel:GitOvercenterKernel} {
    this.#replica+=1;
    const repo=join(this.root,`replica-${this.#replica}.git`);
    execFileSync('git',['init','--bare',repo],{stdio:'ignore'});
    this.git(['remote','add','origin',this.authority],repo);
    this.git(['fetch','--no-tags','origin',`+${STATE_REF}:${STATE_REF}`],repo);
    return {repo,kernel:new GitOvercenterKernel(repo,{remote:'origin'})};
  }

  close():void {
    rmSync(this.root,{recursive:true,force:true});
  }

  #obligation(id:string,{
    content,
    packet={},
    dependencies=[],
    consistency='strong',
    path=this.path(id),
  }:FileSpec) {
    return {
      id,
      packet,
      dependencies,
      postcondition:{
        verifier:consistency==='eventual'
          ? 'eventually-consistent-file-content-equals/v1' as const
          : 'file-content-equals/v1' as const,
        path,
        content,
      },
    };
  }
}
