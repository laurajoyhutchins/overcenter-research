import path from 'node:path';
import { sha256 } from './digest.ts';

export interface ExecutionManifestInput {
  task_id:string;
  workspace:string;
  workspace_dev:string;
  workspace_ino:string;
  program:string;
  args?:string[];
  environment?:Record<string,string>;
  runtime_read_only?:string[];
  runtime_executable?:string[];
}

export interface RenderedExecutionManifest {
  bytes:string;
  sha256:string;
}

const scalar=(name:string,value:string):string=>{
  if (!value) throw new Error(`${name.toUpperCase()}_EMPTY`);
  if (/[\t\r\n\0]/u.test(value)) throw new Error(`${name.toUpperCase()}_INVALID`);
  return value;
};

const absolutePath=(name:string,value:string):string=>{
  scalar(name,value);
  if (!path.isAbsolute(value)) throw new Error(`${name.toUpperCase()}_NOT_ABSOLUTE`);
  return value;
};

const decimal=(name:string,value:string):string=>{
  scalar(name,value);
  if (!/^[0-9]+$/u.test(value)) throw new Error(`${name.toUpperCase()}_NOT_DECIMAL`);
  return value;
};

const envName=(value:string):string=>{
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error('ENV_NAME_INVALID');
  return value;
};

const unique=(name:string,values:string[]):string[]=>{
  const seen=new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${name.toUpperCase()}_DUPLICATE`);
    seen.add(value);
  }
  return values;
};

export function renderExecutionManifest(input:ExecutionManifestInput):RenderedExecutionManifest {
  const taskId=scalar('task_id',input.task_id);
  const workspace=absolutePath('workspace',input.workspace);
  const workspaceDev=decimal('workspace_dev',input.workspace_dev);
  const workspaceIno=decimal('workspace_ino',input.workspace_ino);
  const program=absolutePath('program',input.program);
  const args=(input.args ?? []).map((value)=>scalar('arg',value));

  const environment=Object.entries(input.environment ?? {})
    .map(([name,value])=>[envName(name),scalar(`env_${name}`,value)] as const)
    .sort(([left],[right])=>left.localeCompare(right));

  const runtimeReadOnly=unique(
    'runtime_read_only',
    (input.runtime_read_only ?? []).map((value)=>absolutePath('runtime_read_only',value)),
  ).sort();
  const runtimeExecutable=unique(
    'runtime_executable',
    (input.runtime_executable ?? []).map((value)=>absolutePath('runtime_executable',value)),
  ).sort();

  const lines=[
    'OVERCENTER_EXEC_V1',
    `task_id\t${taskId}`,
    `workspace\t${workspace}`,
    `workspace_dev\t${workspaceDev}`,
    `workspace_ino\t${workspaceIno}`,
    `program\t${program}`,
    ...args.map((value)=>`arg\t${value}`),
    ...environment.map(([name,value])=>`env\t${name}\t${value}`),
    ...runtimeReadOnly.map((value)=>`runtime_ro\t${value}`),
    ...runtimeExecutable.map((value)=>`runtime_exec\t${value}`),
  ];
  const bytes=`${lines.join('\n')}\n`;
  return {bytes,sha256:sha256(bytes)};
}
