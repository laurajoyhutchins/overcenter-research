import { randomUUID } from 'node:crypto';
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
import { dirname, join } from 'node:path';

import { evidenceRef, validateEvidenceRef, type EvidenceRef } from './reference.ts';
import type { EvidenceStore } from './store.ts';

export class FileEvidenceStore implements EvidenceStore {
  readonly root:string;

  constructor(root:string) {
    this.root=root;
    mkdirSync(root,{recursive:true});
  }

  put(bytes:Uint8Array):EvidenceRef {
    const payload=Buffer.from(bytes);
    const ref=evidenceRef(payload);
    const target=this.pathFor(ref);
    const directory=dirname(target);
    mkdirSync(directory,{recursive:true});

    if (existsSync(target)) {
      this.#readVerified(ref,target);
      return ref;
    }

    const temporary=join(
      directory,
      `.tmp-${process.pid}-${randomUUID()}`,
    );
    const descriptor=openSync(temporary,'wx',0o600);
    try {
      writeFileSync(descriptor,payload);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    try {
      try {
        linkSync(temporary,target);
        this.#fsyncDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
        this.#readVerified(ref,target);
      }
    } finally {
      try { unlinkSync(temporary); } catch {}
    }

    this.#readVerified(ref,target);
    return ref;
  }

  get(value:EvidenceRef):Buffer {
    const ref=validateEvidenceRef(value);
    return this.#readVerified(ref,this.pathFor(ref));
  }

  pathFor(value:EvidenceRef):string {
    const ref=validateEvidenceRef(value);
    return join(this.root,ref.digest.slice(0,2),ref.digest.slice(2));
  }

  sweepStaleTemps(olderThanMs:number):number {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs<1) {
      throw new Error('INVALID_EVIDENCE_TEMP_AGE');
    }
    const now=Date.now();
    let removed=0;
    for (const shard of readdirSync(this.root,{withFileTypes:true})) {
      if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
      const directory=join(this.root,shard.name);
      let changed=false;
      for (const name of readdirSync(directory)) {
        if (!name.startsWith('.tmp-')) continue;
        const path=join(directory,name);
        if (now-statSync(path).mtimeMs<olderThanMs) continue;
        unlinkSync(path);
        removed+=1;
        changed=true;
      }
      if (changed) this.#fsyncDirectory(directory);
    }
    return removed;
  }

  #readVerified(ref:EvidenceRef,path:string):Buffer {
    let payload:Buffer;
    try {
      payload=readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code==='ENOENT') {
        throw new Error('EVIDENCE_NOT_FOUND');
      }
      throw error;
    }
    if (payload.byteLength!==ref.byte_length) {
      throw new Error('EVIDENCE_LENGTH_MISMATCH');
    }
    const actual=evidenceRef(payload);
    if (actual.digest!==ref.digest) throw new Error('EVIDENCE_DIGEST_MISMATCH');
    return payload;
  }

  #fsyncDirectory(directory:string):void {
    const descriptor=openSync(directory,'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
