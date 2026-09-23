import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

const LIMIT=10_000;
const EXTENSIONS=/\.(?:c|cc|cpp|cjs|go|h|hpp|js|mjs|py|rs|sh|ts|tsx)$/;

function files(root:string):string[] {
  return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
    const path=join(root,entry.name);
    return entry.isDirectory()?files(path):EXTENSIONS.test(entry.name)?[path]:[];
  });
}

const counts=files('src').map(path=>({
  path,
  lines:readFileSync(path,'utf8').split(/\r?\n/).length,
}));
const total=counts.reduce((sum,item)=>sum+item.lines,0);
console.log(`src lines: ${total}/${LIMIT}`);
if (total>LIMIT) {
  for (const item of counts.sort((a,b)=>b.lines-a.lines).slice(0,10)) {
    console.error(`${item.lines}\t${item.path}`);
  }
  process.exitCode=1;
}
