import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const repositoryRoot=fileURLToPath(new URL('../../',import.meta.url));

const ignoredTopLevel=new Set([
  '.git',
  '.overcenter-build',
  '.stryker-tmp',
  'coverage',
  'node_modules',
]);

function ignored(relative:string):boolean {
  const normalized=relative.replaceAll('\\','/');
  const [top]=normalized.split('/');
  if (ignoredTopLevel.has(top)) return true;
  return normalized==='formal/.tlc' || normalized.startsWith('formal/.tlc/');
}

export function repositorySourceFiles(root=repositoryRoot):string[] {
  const files:string[]=[];
  const visit=(directory:string,prefix:string):void=>{
    const entries=readdirSync(directory,{withFileTypes:true})
      .sort((left,right)=>left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative=prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored(relative)) continue;
      const absolute=join(directory,entry.name);
      if (entry.isDirectory()) {
        visit(absolute,relative);
        continue;
      }
      files.push(relative);
    }
  };
  visit(root,'');
  return files;
}

export function copyRepositorySource(destination:string,root=repositoryRoot):void {
  mkdirSync(destination,{recursive:true});
  for (const relative of repositorySourceFiles(root)) {
    const source=join(root,...relative.split('/'));
    const target=join(destination,...relative.split('/'));
    mkdirSync(dirname(target),{recursive:true});
    const stat=lstatSync(source);
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(source),target);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`REPOSITORY_SOURCE_ENTRY_UNSUPPORTED:${relative}`);
    }
    copyFileSync(source,target);
    chmodSync(target,stat.mode&0o777);
  }
}
