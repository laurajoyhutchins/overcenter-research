import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));

export function contractPackage(id) {
  const contracts=join(repositoryRoot,'contracts');
  const matches=[];
  for (const entry of readdirSync(contracts,{withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const directory=join(contracts,entry.name);
    const metadataPath=join(directory,'contract.json');
    if (!existsSync(metadataPath)) continue;
    const metadata=JSON.parse(readFileSync(metadataPath,'utf8'));
    if (metadata.id===id) matches.push(directory);
  }
  if (matches.length!==1) {
    throw new Error(`CONTRACT_PACKAGE_${matches.length===0?'NOT_FOUND':'AMBIGUOUS'}:${id}`);
  }
  return matches[0];
}
