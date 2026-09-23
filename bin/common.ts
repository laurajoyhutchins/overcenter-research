import {appendFileSync} from 'node:fs';

import type {ProjectCommandContext} from '../src/authority/project-agent-protocol.ts';

export function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

export function option(name:string):string|null {
  const index=process.argv.indexOf(name);
  if (index<0) return null;
  const value=process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(`${name}_REQUIRES_VALUE`);
  return value;
}

export function commandContext():ProjectCommandContext {
  const integer=(name:string)=>{
    const value=Number(required(name));
    if (!Number.isSafeInteger(value) || value<=0) throw new Error(`${name}_INVALID`);
    return value;
  };
  return {
    repository_id:integer('OVERCENTER_COMMAND_REPOSITORY_ID'),
    repository_full_name:required('OVERCENTER_COMMAND_REPOSITORY'),
    command_source_sha:required('OVERCENTER_COMMAND_SOURCE_SHA'),
    command_run_id:integer('OVERCENTER_COMMAND_RUN_ID'),
    command_run_attempt:integer('OVERCENTER_COMMAND_RUN_ATTEMPT'),
  };
}

export function githubOutput(values:Record<string,unknown>):void {
  const output=process.env.GITHUB_OUTPUT;
  if (!output) return;
  for (const [key,value] of Object.entries(values)) {
    appendFileSync(output,`${key}=${String(value)}\n`);
  }
}
