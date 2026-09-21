import {readdirSync,readFileSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const roots=['src','bin','executor'].map(path=>join(root,path));
const excluded=new Set([
  join(root,'src/generated'),
  join(root,'src/schema-identifiers.generated.mjs'),
  join(root,'executor/schema_identifiers_generated.go'),
]);
const versionedContractPath=/contracts\/[^'"\`\n]*-v\d+\//u;
const versionedSchemaLiteral=/(?:schema|verifier)[^\n]*['"\`][^'"\`\n]*(?:-v\d+|\/v\d+)[^'"\`\n]*['"\`]|['"\`][^'"\`\n]*(?:-v\d+|\/v\d+)[^'"\`\n]*['"\`][^\n]*(?:schema|verifier)/iu;

function files(path) {
  if (excluded.has(path)) return [];
  const stat=statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path).flatMap(name=>files(join(path,name)));
}

const violations=[];
for (const path of roots.flatMap(files)) {
  if (!/\.(?:ts|mjs|js|go)$/u.test(path)) continue;
  const source=readFileSync(path,'utf8');
  source.split('\n').forEach((line,index)=>{
    if (versionedContractPath.test(line)||versionedSchemaLiteral.test(line)) {
      violations.push(`${relative(root,path)}:${index+1}: ${line.trim()}`);
    }
  });
}
if (violations.length) {
  console.error('Hard-coded schema versions found outside authoritative/generated boundaries:\n'+violations.join('\n'));
  process.exit(1);
}
