import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import { canonicalDigest } from './digest.ts';

interface SourceTreeFileEntry {
  path:string;
  type:'file';
  executable:boolean;
  sha256:string;
}

interface SourceTreeSymlinkEntry {
  path:string;
  type:'symlink';
  target:string;
}

type SourceTreeEntry=SourceTreeFileEntry|SourceTreeSymlinkEntry;

function fileSha256(path:string):string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function sourceTreeSha256(root:string):string {
  const entries:SourceTreeEntry[]=[];

  const visit=(directory:string,prefix:string):void=>{
    for (const name of readdirSync(directory).sort()) {
      const absolute=join(directory,name);
      const relative=prefix ? `${prefix}/${name}` : name;
      const stat=lstatSync(absolute);

      if (stat.isDirectory()) {
        visit(absolute,relative);
        continue;
      }
      if (stat.isFile()) {
        entries.push({
          path:relative,
          type:'file',
          executable:(stat.mode&0o111)!==0,
          sha256:fileSha256(absolute),
        });
        continue;
      }
      if (stat.isSymbolicLink()) {
        entries.push({
          path:relative,
          type:'symlink',
          target:readlinkSync(absolute),
        });
        continue;
      }
      throw new Error(`SOURCE_TREE_ENTRY_UNSUPPORTED:${relative}`);
    }
  };

  visit(root,'');
  return 'sha256:'+canonicalDigest(entries);
}

export function executionContextSha256(value:unknown):string {
  return 'sha256:'+canonicalDigest(value);
}
