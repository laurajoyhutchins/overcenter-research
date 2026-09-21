import path from 'node:path';
import { sha256 } from './digest.ts';

export interface ExecutionManifestInput {
  task_id:string;
  workspace:string;
  workspace_dev:string;
  workspace_ino:string;
  program:string;
  timeout_ms?:number;
  max_output_bytes?:number;
  memory_max_bytes:string;
  pids_max:string;
  cpu_quota_us:string;
  cpu_period_us:string;
  args?:string[];
  environment?:Record<string,string>;
  runtime_read_only?:string[];
  runtime_executable?:string[];
}

export interface RenderedExecutionManifest {
  bytes:string;
  sha256:string;
  timeout_ms:number;
  max_output_bytes:number;
  memory_max_bytes:string;
  pids_max:string;
  cpu_quota_us:string;
  cpu_period_us:string;
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

const MAX_U64=(1n<<64n)-1n;
const DEFAULT_TIMEOUT_MS=60_000;
const DEFAULT_MAX_OUTPUT_BYTES=1_048_576;
const MAX_TIMEOUT_MS=2_147_483_647;

const positiveSafeInteger=(name:string,value:number,max=Number.MAX_SAFE_INTEGER):number=>{
  if (!Number.isSafeInteger(value) || value<=0 || value>max) {
    throw new Error(`${name.toUpperCase()}_INVALID`);
  }
  return value;
};

const decimal=(name:string,value:string):string=>{
  scalar(name,value);
  if (!/^[0-9]+$/u.test(value)) throw new Error(`${name.toUpperCase()}_NOT_DECIMAL`);
  if (value.length>1 && value.startsWith('0')) throw new Error(`${name.toUpperCase()}_NOT_CANONICAL`);
  if (BigInt(value)>MAX_U64) throw new Error(`${name.toUpperCase()}_OUT_OF_RANGE`);
  return value;
};

const envName=(value:string):string=>{
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error('ENV_NAME_INVALID');
  return value;
};

const codeUnitCompare=(left:string,right:string):number=>left<right ? -1 : left>right ? 1 : 0;

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
  const timeoutMs=positiveSafeInteger('timeout_ms',input.timeout_ms ?? DEFAULT_TIMEOUT_MS,MAX_TIMEOUT_MS);
  const maxOutputBytes=positiveSafeInteger(
    'max_output_bytes',
    input.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  );
  const memoryMaxBytes=decimal('memory_max_bytes',input.memory_max_bytes);
  const pidsMax=decimal('pids_max',input.pids_max);
  const cpuQuotaUs=decimal('cpu_quota_us',input.cpu_quota_us);
  const cpuPeriodUs=decimal('cpu_period_us',input.cpu_period_us);
  if (memoryMaxBytes==='0') throw new Error('MEMORY_MAX_BYTES_INVALID');
  if (pidsMax==='0') throw new Error('PIDS_MAX_INVALID');
  if (cpuQuotaUs==='0') throw new Error('CPU_QUOTA_US_INVALID');
  if (cpuPeriodUs==='0') throw new Error('CPU_PERIOD_US_INVALID');
  const args=(input.args ?? []).map((value)=>scalar('arg',value));

  const environment=Object.entries(input.environment ?? {})
    .map(([name,value])=>[envName(name),scalar(`env_${name}`,value)] as const)
    .sort(([left],[right])=>codeUnitCompare(left,right));

  const runtimeReadOnly=unique(
    'runtime_read_only',
    (input.runtime_read_only ?? []).map((value)=>absolutePath('runtime_read_only',value)),
  ).sort();
  const runtimeExecutable=unique(
    'runtime_executable',
    (input.runtime_executable ?? []).map((value)=>absolutePath('runtime_executable',value)),
  ).sort();
  const runtimeReadOnlySet=new Set(runtimeReadOnly);
  if (runtimeExecutable.some((value)=>runtimeReadOnlySet.has(value))) {
    throw new Error('RUNTIME_ACCESS_CONFLICT');
  }

  const lines=[
    'OVERCENTER_EXEC_V1',
    `task_id\t${taskId}`,
    `workspace\t${workspace}`,
    `workspace_dev\t${workspaceDev}`,
    `workspace_ino\t${workspaceIno}`,
    `program\t${program}`,
    `timeout_ms\t${timeoutMs}`,
    `max_output_bytes\t${maxOutputBytes}`,
    `memory_max_bytes\t${memoryMaxBytes}`,
    `pids_max\t${pidsMax}`,
    `cpu_quota_us\t${cpuQuotaUs}`,
    `cpu_period_us\t${cpuPeriodUs}`,
    ...args.map((value)=>`arg\t${value}`),
    ...environment.map(([name,value])=>`env\t${name}\t${value}`),
    ...runtimeReadOnly.map((value)=>`runtime_ro\t${value}`),
    ...runtimeExecutable.map((value)=>`runtime_exec\t${value}`),
  ];
  const bytes=`${lines.join('\n')}\n`;
  return {
    bytes,
    sha256:sha256(bytes),
    timeout_ms:timeoutMs,
    max_output_bytes:maxOutputBytes,
    memory_max_bytes:memoryMaxBytes,
    pids_max:pidsMax,
    cpu_quota_us:cpuQuotaUs,
    cpu_period_us:cpuPeriodUs,
  };
}
