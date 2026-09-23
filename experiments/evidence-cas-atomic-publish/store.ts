import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

export type CrashPhase='after-temp-fsync'|'after-link-fsync'|null;

export class AtomicFileCas {
  readonly dir:string;

  constructor(dir:string) {
    this.dir=dir;
    mkdirSync(dir,{recursive:true});
  }

  path(id:string):string {
    return join(this.dir,id);
  }

  put(bytes:Buffer,crashPhase:CrashPhase=null):{id:string;created:boolean} {
    const id=sha(bytes);
    const target=this.path(id);
    if (existsSync(target)) {
      this.#verify(id,target);
      return {id,created:false};
    }

    const temp=join(this.dir,'.tmp-'+process.pid+'-'+randomUUID());
    const fd=openSync(temp,'wx',0o600);
    try {
      writeFileSync(fd,bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    if (crashPhase==='after-temp-fsync') {
      process.kill(process.pid,'SIGKILL');
      throw new Error('UNREACHABLE');
    }

    let created=false;
    try {
      linkSync(temp,target);
      created=true;
      this.#fsyncDir();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code!=='EEXIST') {
        try { unlinkSync(temp); } catch {}
        throw error;
      }
      this.#verify(id,target);
    }

    if (crashPhase==='after-link-fsync') {
      process.kill(process.pid,'SIGKILL');
      throw new Error('UNREACHABLE');
    }

    unlinkSync(temp);
    if (!created) this.#verify(id,target);
    return {id,created};
  }

  get(id:string):Buffer {
    const target=this.path(id);
    this.#verify(id,target);
    return readFileSync(target);
  }

  sweepTemps({olderThanMs=0}:{olderThanMs?:number}={}):number {
    const now=Date.now();
    let removed=0;
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith('.tmp-')) continue;
      const path=join(this.dir,name);
      if (now-statSync(path).mtimeMs<olderThanMs) continue;
      unlinkSync(path);
      removed+=1;
    }
    if (removed>0) this.#fsyncDir();
    return removed;
  }

  tempNames():string[] {
    return readdirSync(this.dir).filter(name=>name.startsWith('.tmp-'));
  }

  objectNames():string[] {
    return readdirSync(this.dir).filter(name=>/^[0-9a-f]{64}$/.test(name));
  }

  #verify(id:string,path:string):void {
    const bytes=readFileSync(path);
    if (sha(bytes)!==id) throw new Error('EVIDENCE_EXISTING_DIGEST_MISMATCH');
  }

  #fsyncDir():void {
    const fd=openSync(this.dir,'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

export function evidenceBytes(size=256*1024):Buffer {
  return Buffer.from('e'.repeat(size));
}

export function evidenceDigest(bytes:Buffer):string {
  return sha(bytes);
}
