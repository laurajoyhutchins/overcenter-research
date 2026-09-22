import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

import {GITHUB_AGENT_AUTHORITY_REF} from '../src/github-agent-authority.ts';
import {GitOvercenterKernel} from '../src/git-kernel.ts';
import {advanceProject} from '../src/project-advance.ts';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function option(name:string):string|null {
  const index=process.argv.indexOf(name);
  if (index<0) return null;
  const value=process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(`${name}_REQUIRES_VALUE`);
  return value;
}

const outputPath=option('--output');
if (!outputPath) {
  throw new Error('usage: github-project-advance.ts --output <path>');
}

const kernel=new GitOvercenterKernel(process.cwd(),{
  remote:'origin',
  ref:GITHUB_AGENT_AUTHORITY_REF,
  githubToken:required('GITHUB_TOKEN'),
});
kernel.initialize();

const result=await advanceProject(kernel);
mkdirSync(dirname(outputPath),{recursive:true});
writeFileSync(outputPath,`${JSON.stringify(result,null,2)}\n`);

const output=process.env.GITHUB_OUTPUT;
if (output) {
  const packet=result.outcome==='AGENT_EXECUTION_REQUIRED'
    ? result.packet
    : null;
  for (const [key,value] of Object.entries({
    outcome:result.outcome,
    authority_revision:result.authority_revision,
    obligation_id:packet?.work.id??('work' in result?result.work.id:''),
    run_id:packet?.run_id??('work' in result?result.work.run_id??'':''),
  })) {
    appendFileSync(output,`${key}=${String(value)}\n`);
  }
}

console.log(JSON.stringify(result));
