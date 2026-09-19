import { execFileSync } from 'node:child_process';

import {
  factCommitFromFiles,
  type DurableFactStore,
} from './fact-store.ts';
import type { FactCommit } from './facts.ts';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
}

const json=(value:unknown)=>`${JSON.stringify(value,null,2)}\n`;

export class GitFactStore implements DurableFactStore {
  readonly repo:string;
  readonly ref:string;
  readonly remote:string|null;

  constructor(
    repo:string,
    {ref,remote=null}:{ref:string;remote?:string|null},
  ) {
    this.repo=repo;
    this.ref=ref;
    this.remote=remote;
    this.#git(['rev-parse','--git-dir']);
  }

  head():string|null {
    if (!this.remote) {
      const result=this.#git(['rev-parse','-q','--verify',this.ref],{allowFailure:true});
      return result.ok ? result.stdout.trim() : null;
    }
    const listed=this.#git(['ls-remote',this.remote,this.ref],{allowFailure:true});
    if (!listed.ok) throw new Error('AUTHORITY_UNREACHABLE');
    const line=listed.stdout.trim();
    if (!line) {
      this.#git(['update-ref','-d',this.ref],{allowFailure:true});
      return null;
    }
    const sha=line.split(/\s+/)[0];
    const fetched=this.#git(
      ['fetch','--no-tags',this.remote,`+${this.ref}:${this.ref}`],
      {allowFailure:true},
    );
    if (!fetched.ok) throw new Error('AUTHORITY_UNREACHABLE');
    return sha;
  }

  append(
    expectedHead:string|null,
    message:string,
    files:Record<string,unknown>={},
  ):string|null {
    const commit=this.createCommit(expectedHead,message,files);
    const expected=expectedHead??this.zeroObjectId();
    return this.cas(commit,expected) ? commit : null;
  }

  history(head:string):FactCommit[] {
    return this.revisions(head).map(commit=>{
      const files:Record<string,unknown>={};
      for (const path of [
        'obligation.json',
        'claim.json',
        'execution-authority.json',
        'accepted-worker-result.json',
        'effect-reservation.json',
        'receipt.json',
      ]) {
        const value=this.readJson(commit,path);
        if (value!=null) files[path]=value;
      }
      return factCommitFromFiles(
        commit,
        this.parent(commit),
        files,
      );
    });
  }

  revisions(head:string):string[] {
    return this.#git(['rev-list','--reverse',head]).stdout.trim().split(/\n+/).filter(Boolean);
  }

  parent(commit:string):string|null {
    const result=this.#git(['rev-parse',`${commit}^`],{allowFailure:true});
    return result.ok ? result.stdout.trim() : null;
  }

  readJson(commit:string,path:string):unknown|null {
    const result=this.#git(['show',`${commit}:${path}`],{allowFailure:true});
    return result.ok ? JSON.parse(result.stdout) : null;
  }

  createCommit(
    parent:string|null,
    message:string,
    files:Record<string,unknown>={},
  ):string {
    const entries=Object.entries(files)
      .map(([name,value])=>[name,this.#blob(json(value))] as const)
      .sort(([a],[b])=>a.localeCompare(b));
    const treeInput=entries
      .map(([name,sha])=>`100644 blob ${sha}\t${name}\n`)
      .join('');
    const tree=this.#git(['mktree'],{input:treeInput}).stdout.trim();
    const args=['commit-tree',tree];
    if (parent) args.push('-p',parent);
    const env={
      ...process.env,
      GIT_AUTHOR_NAME:'Overcenter Kernel',
      GIT_AUTHOR_EMAIL:'overcenter@local',
      GIT_COMMITTER_NAME:'Overcenter Kernel',
      GIT_COMMITTER_EMAIL:'overcenter@local',
    };
    return this.#git(args,{input:`${message}\n`,env}).stdout.trim();
  }

  cas(next:string,expected:string):boolean {
    if (!this.remote) {
      return this.#git(['update-ref',this.ref,next,expected],{allowFailure:true}).ok;
    }
    const zero='0'.repeat(this.#objectIdLength());
    const lease=expected===zero
      ? `--force-with-lease=${this.ref}:`
      : `--force-with-lease=${this.ref}:${expected}`;
    const pushed=this.#git(
      ['push','--porcelain',lease,this.remote,`${next}:${this.ref}`],
      {allowFailure:true},
    );
    if (!pushed.ok) return false;
    this.#git(['update-ref',this.ref,next]);
    return true;
  }

  zeroObjectId():string {
    return '0'.repeat(this.#objectIdLength());
  }

  #blob(content:string):string {
    return this.#git(['hash-object','-w','--stdin'],{input:content}).stdout.trim();
  }

  #objectIdLength():number {
    return this.#git(['rev-parse','--show-object-format']).stdout.trim()==='sha256' ? 64 : 40;
  }

  #git(
    args:string[],
    {
      input=undefined,
      env=process.env,
      allowFailure=false,
    }:{
      input?:string;
      env?:Record<string,string|undefined>;
      allowFailure?:boolean;
    }={},
  ):GitResult {
    try {
      const stdout=execFileSync(
        'git',
        ['-C',this.repo,...args],
        {input,env,encoding:'utf8',stdio:['pipe','pipe','pipe']},
      );
      return {ok:true,stdout};
    } catch (error:unknown) {
      const failure=error as {
        stdout?:string|Buffer;
        stderr?:string|Buffer;
        message?:string;
      };
      if (allowFailure) {
        return {
          ok:false,
          stdout:String(failure.stdout??''),
          stderr:String(failure.stderr??''),
        };
      }
      throw new Error(
        `git ${args.join(' ')} failed: ${String(failure.stderr??failure.message??'').trim()}`,
      );
    }
  }
}
