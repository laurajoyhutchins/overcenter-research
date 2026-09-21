import {readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const [assignmentPath,workspace,mode='scripted-control']=process.argv.slice(2);
if (!assignmentPath || !workspace) throw new Error('usage: worker <assignment.json> <workspace> [mode]');

const assignment=JSON.parse(readFileSync(assignmentPath,'utf8'));
if (assignment.schema!=='overcenter-autonomy-sandbox-assignment/v1') {
  throw new Error('SANDBOX_ASSIGNMENT_SCHEMA_MISMATCH');
}
if (mode==='noop-control') {
  console.log(JSON.stringify({mode,changed:false}));
  process.exit(0);
}
if (mode!=='scripted-control') throw new Error('SANDBOX_WORKER_MODE_UNSUPPORTED');

const src=join(workspace,'src');
rmSync(join(src,'math.js'));
rmSync(join(src,'format.js'));
rmSync(join(src,'index.js'));

writeFileSync(join(src,'math.ts'),`export function add(a:number,b:number):number {
  return a + b;
}

export function clamp(value:number,min:number,max:number):number {
  return Math.min(max, Math.max(min, value));
}
`);

writeFileSync(join(src,'format.ts'),`export interface User {
  name:string;
  email:string;
}

export function formatUser(user:User):string {
  return \`${user.name} <${user.email}>\`;
}

export function initials(name:string):string {
  return name.split(/\\s+/).filter(Boolean).map(part => part[0].toUpperCase()).join('');
}
`);

writeFileSync(join(src,'index.ts'),`export {add, clamp} from './math.ts';
export {formatUser, initials} from './format.ts';
`);

console.log(JSON.stringify({mode,changed:true,objective:assignment.objective_id}));
