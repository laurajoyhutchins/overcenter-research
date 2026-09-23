import {createHash} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

export const ASSIGNMENT_SCHEMA='overcenter-agent-assignment/v1' as const;
export const CANDIDATE_SCHEMA='overcenter-agent-candidate/v1' as const;
export const AGENT_TASK_PACKET_SCHEMA='overcenter-agent-task/v1' as const;

type AssignmentMode='100644'|'100755';

export interface AssignmentTaskPacket {
  schema:typeof AGENT_TASK_PACKET_SCHEMA;
  kind:'pure-candidate';
  source_sha:string;
  command:string[];
  required_paths:string[];
  output_path:string;
}

export interface AssignmentWork extends Record<string,unknown> {
  id:string;
  revision:string;
  run_id:string;
  claimed_revision:string;
  status:'EXECUTING';
  execution_generation:number;
  packet:AssignmentTaskPacket;
}

export interface AssignmentFile {
  path:string;
  mode:AssignmentMode;
  sha256:string;
  content_base64:string;
}

export interface Assignment {
  schema:typeof ASSIGNMENT_SCHEMA;
  work:AssignmentWork;
  files:AssignmentFile[];
}

export interface Candidate {
  schema:typeof CANDIDATE_SCHEMA;
  assignment_sha256:string;
  obligation_id:string;
  run_id:string;
  claimed_revision:string;
  output_path:string;
  output_sha256:string;
  output_base64:string;
}

const sha256=(bytes:string|Buffer|Uint8Array):string=>
  createHash('sha256').update(bytes).digest('hex');
const fail=(code:string):never=>{throw new Error(code);};
const record=(value:unknown):value is Record<string,unknown> =>
  !!value && typeof value==='object' && !Array.isArray(value);

export function validPath(value:unknown):value is string {
  if (typeof value!=='string' || value.length===0 || value.startsWith('/')) return false;
  if ([...value].some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127)) return false;
  const parts=value.split('/');
  return parts.every(part=>part!=='' && part!=='.' && part!=='..');
}

function exactKeys(
  value:unknown,
  required:readonly string[],
  name:string,
):asserts value is Record<string,unknown> {
  if (!record(value)) fail(`${name}_INVALID`);
  const keys=Object.keys(value).sort();
  const expected=[...required].sort();
  if (keys.length!==expected.length || keys.some((key,index)=>key!==expected[index])) {
    fail(`${name}_SHAPE_INVALID`);
  }
}

function decodeBase64(value:unknown):Buffer {
  if (typeof value!=='string') fail('ASSIGNMENT_FILE_BASE64_INVALID');
  const bytes=Buffer.from(value,'base64');
  if (bytes.toString('base64')!==value) fail('ASSIGNMENT_FILE_BASE64_INVALID');
  return bytes;
}

export function validateAssignment(value:unknown):Assignment {
  exactKeys(value,['schema','work','files'],'ASSIGNMENT');
  if (value.schema!==ASSIGNMENT_SCHEMA) fail('ASSIGNMENT_SCHEMA_MISMATCH');

  if (!record(value.work)) fail('ASSIGNMENT_WORK_INVALID');
  const work=value.work;
  for (const field of ['id','revision','run_id','claimed_revision'] as const) {
    if (typeof work[field]!=='string' || work[field].length===0) {
      fail(`ASSIGNMENT_WORK_${field.toUpperCase()}_INVALID`);
    }
  }
  if (work.status!=='EXECUTING') fail('ASSIGNMENT_WORK_NOT_EXECUTING');
  if (
    typeof work.execution_generation!=='number'
    || !Number.isSafeInteger(work.execution_generation)
    || work.execution_generation<1
  ) {
    fail('ASSIGNMENT_EXECUTION_GENERATION_INVALID');
  }

  const packet=work.packet;
  if (!record(packet) || packet.schema!==AGENT_TASK_PACKET_SCHEMA) {
    fail('ASSIGNMENT_PACKET_SCHEMA_MISMATCH');
  }
  exactKeys(packet,[
    'schema','kind','source_sha','command','required_paths','output_path',
  ],'ASSIGNMENT_PACKET');
  if (packet.kind!=='pure-candidate') fail('ASSIGNMENT_PACKET_KIND_INVALID');
  if (typeof packet.source_sha!=='string' || !/^[0-9a-f]{40}$/.test(packet.source_sha)) {
    fail('ASSIGNMENT_SOURCE_SHA_INVALID');
  }
  if (
    !Array.isArray(packet.command)
    || packet.command.length===0
    || !packet.command.every(
      (part:unknown):part is string=>typeof part==='string' && part.length>0,
    )
  ) {
    fail('ASSIGNMENT_COMMAND_INVALID');
  }
  if (
    !Array.isArray(packet.required_paths)
    || packet.required_paths.length===0
    || !packet.required_paths.every(validPath)
  ) {
    fail('ASSIGNMENT_REQUIRED_PATHS_INVALID');
  }
  if (new Set(packet.required_paths).size!==packet.required_paths.length) {
    fail('ASSIGNMENT_REQUIRED_PATHS_DUPLICATE');
  }
  if (!validPath(packet.output_path)) fail('ASSIGNMENT_OUTPUT_PATH_INVALID');

  if (!Array.isArray(value.files) || value.files.length===0) fail('ASSIGNMENT_FILES_INVALID');
  const seen=new Set<string>();
  for (const file of value.files) {
    exactKeys(file,['path','mode','sha256','content_base64'],'ASSIGNMENT_FILE');
    if (!validPath(file.path)) fail('ASSIGNMENT_FILE_PATH_INVALID');
    if (seen.has(file.path)) fail('ASSIGNMENT_FILE_PATH_DUPLICATE');
    seen.add(file.path);
    if (file.mode!=='100644' && file.mode!=='100755') fail('ASSIGNMENT_FILE_MODE_INVALID');
    if (typeof file.sha256!=='string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      fail('ASSIGNMENT_FILE_SHA256_INVALID');
    }
    const bytes=decodeBase64(file.content_base64);
    if (sha256(bytes)!==file.sha256) fail('ASSIGNMENT_FILE_DIGEST_MISMATCH');
  }
  for (const required of packet.required_paths) {
    if (!seen.has(required)) fail(`ASSIGNMENT_REQUIRED_FILE_MISSING:${required}`);
  }

  return value as unknown as Assignment;
}

export function assignmentFile(
  pathname:string,
  bytes:string|Buffer|Uint8Array,
  mode:AssignmentMode='100644',
):AssignmentFile {
  const data=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
  return {
    path:pathname,
    mode,
    sha256:sha256(data),
    content_base64:data.toString('base64'),
  };
}

export function buildAssignment(work:unknown,files:AssignmentFile[]):Assignment {
  return validateAssignment({
    schema:ASSIGNMENT_SCHEMA,
    work:structuredClone(work),
    files:files.map(file=>structuredClone(file)),
  });
}

export function encodeAssignment(assignment:unknown):Buffer {
  const validated=validateAssignment(assignment);
  return Buffer.from(`${JSON.stringify(validated,null,2)}\n`,'utf8');
}

function listFiles(root:string,prefix=''):string[] {
  const found:string[]=[];
  if (!existsSync(root)) return found;
  for (const name of readdirSync(root).sort()) {
    const absolute=join(root,name);
    const relative=prefix?`${prefix}/${name}`:name;
    const stat=lstatSync(absolute);
    if (stat.isDirectory()) found.push(...listFiles(absolute,relative));
    else if (stat.isFile()) found.push(relative);
    else fail(`ASSIGNMENT_WORKSPACE_ENTRY_INVALID:${relative}`);
  }
  return found;
}

export function materializeAssignment(assignment:unknown,root:string):string[] {
  const validated=validateAssignment(assignment);
  mkdirSync(root,{recursive:true});
  if (readdirSync(root).length!==0) fail('ASSIGNMENT_WORKSPACE_NOT_EMPTY');
  for (const file of validated.files) {
    const absolute=join(root,...file.path.split('/'));
    mkdirSync(dirname(absolute),{recursive:true});
    const bytes=decodeBase64(file.content_base64);
    writeFileSync(absolute,bytes,{flag:'wx'});
    chmodSync(absolute,file.mode==='100755'?0o755:0o644);
  }
  const expected=validated.files.map(file=>file.path).sort();
  const actual=listFiles(root).sort();
  if (JSON.stringify(actual)!==JSON.stringify(expected)) {
    fail('ASSIGNMENT_WORKSPACE_MEMBERSHIP_MISMATCH');
  }
  return actual;
}

export function assignmentSha256(bytes:string|Buffer|Uint8Array):string {
  return sha256(bytes);
}

export function validateCandidate(
  value:unknown,
  assignment:unknown,
  assignmentBytes:string|Buffer|Uint8Array,
):Candidate {
  const validatedAssignment=validateAssignment(assignment);
  exactKeys(value,[
    'schema','assignment_sha256','obligation_id','run_id','claimed_revision',
    'output_path','output_sha256','output_base64',
  ],'CANDIDATE');
  if (value.schema!==CANDIDATE_SCHEMA) fail('CANDIDATE_SCHEMA_MISMATCH');
  if (value.assignment_sha256!==assignmentSha256(assignmentBytes)) {
    fail('CANDIDATE_ASSIGNMENT_MISMATCH');
  }
  if (value.obligation_id!==validatedAssignment.work.id) fail('CANDIDATE_OBLIGATION_MISMATCH');
  if (value.run_id!==validatedAssignment.work.run_id) fail('CANDIDATE_RUN_MISMATCH');
  if (value.claimed_revision!==validatedAssignment.work.claimed_revision) {
    fail('CANDIDATE_REVISION_MISMATCH');
  }
  if (value.output_path!==validatedAssignment.work.packet.output_path) {
    fail('CANDIDATE_OUTPUT_PATH_MISMATCH');
  }
  if (typeof value.output_sha256!=='string' || !/^[0-9a-f]{64}$/.test(value.output_sha256)) {
    fail('CANDIDATE_OUTPUT_SHA256_INVALID');
  }
  const bytes=decodeBase64(value.output_base64);
  if (sha256(bytes)!==value.output_sha256) fail('CANDIDATE_OUTPUT_DIGEST_MISMATCH');
  return value as unknown as Candidate;
}

export function runAssignment(
  assignmentPath:string,
  workspace:string,
  candidatePath:string,
):Candidate {
  const assignmentBytes=readFileSync(assignmentPath);
  const assignment=validateAssignment(JSON.parse(assignmentBytes.toString('utf8')));
  materializeAssignment(assignment,workspace);
  const command=assignment.work.packet.command;
  const run=spawnSync(command[0],command.slice(1),{
    cwd:workspace,
    env:{PATH:process.env.PATH??'/usr/bin:/bin'},
    encoding:'utf8',
    timeout:10_000,
  });
  if (run.error) throw run.error;
  if (run.status!==0) {
    throw new Error(`ASSIGNMENT_COMMAND_FAILED:${run.status}:${run.stderr??''}`);
  }
  const outputPath=assignment.work.packet.output_path;
  const outputFile=join(workspace,...outputPath.split('/'));
  if (
    !existsSync(outputFile)
    || lstatSync(outputFile).isSymbolicLink()
    || !lstatSync(outputFile).isFile()
  ) {
    fail('ASSIGNMENT_OUTPUT_MISSING');
  }
  const output=readFileSync(outputFile);
  const candidate:Candidate={
    schema:CANDIDATE_SCHEMA,
    assignment_sha256:assignmentSha256(assignmentBytes),
    obligation_id:assignment.work.id,
    run_id:assignment.work.run_id,
    claimed_revision:assignment.work.claimed_revision,
    output_path:outputPath,
    output_sha256:sha256(output),
    output_base64:output.toString('base64'),
  };
  validateCandidate(candidate,assignment,assignmentBytes);
  writeFileSync(candidatePath,`${JSON.stringify(candidate,null,2)}\n`,'utf8');
  return candidate;
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [command,...args]=process.argv.slice(2);
  if (command==='run' && args.length===3) {
    runAssignment(args[0],args[1],args[2]);
  } else {
    console.error('usage: assignment-capsule.ts run <assignment.json> <workspace> <candidate.json>');
    process.exit(2);
  }
}
