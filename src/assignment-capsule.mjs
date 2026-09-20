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

export const ASSIGNMENT_SCHEMA='overcenter-agent-assignment/v1';
export const CANDIDATE_SCHEMA='overcenter-agent-candidate/v1';
export const AGENT_TASK_PACKET_SCHEMA='overcenter-agent-task/v1';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw new Error(code);};
const record=value=>!!value && typeof value==='object' && !Array.isArray(value);

export function validPath(value) {
  if (typeof value!=='string' || value.length===0 || value.startsWith('/')) return false;
  if ([...value].some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127)) return false;
  const parts=value.split('/');
  return parts.every(part=>part!=='' && part!=='.' && part!=='..');
}

function exactKeys(value,required,name) {
  if (!record(value)) fail(`${name}_INVALID`);
  const keys=Object.keys(value).sort();
  const expected=[...required].sort();
  if (keys.length!==expected.length || keys.some((key,index)=>key!==expected[index])) {
    fail(`${name}_SHAPE_INVALID`);
  }
}

function decodeBase64(value) {
  if (typeof value!=='string') fail('ASSIGNMENT_FILE_BASE64_INVALID');
  const bytes=Buffer.from(value,'base64');
  if (bytes.toString('base64')!==value) fail('ASSIGNMENT_FILE_BASE64_INVALID');
  return bytes;
}

export function validateAssignment(value) {
  exactKeys(value,['schema','work','files'],'ASSIGNMENT');
  if (value.schema!==ASSIGNMENT_SCHEMA) fail('ASSIGNMENT_SCHEMA_MISMATCH');
  if (!record(value.work)) fail('ASSIGNMENT_WORK_INVALID');
  const work=value.work;
  for (const field of ['id','revision','run_id','claimed_revision']) {
    if (typeof work[field]!=='string' || work[field].length===0) fail(`ASSIGNMENT_WORK_${field.toUpperCase()}_INVALID`);
  }
  if (work.status!=='EXECUTING') fail('ASSIGNMENT_WORK_NOT_EXECUTING');
  if (!Number.isSafeInteger(work.execution_generation) || work.execution_generation<1) {
    fail('ASSIGNMENT_EXECUTION_GENERATION_INVALID');
  }
  if (!record(work.packet) || work.packet.schema!==AGENT_TASK_PACKET_SCHEMA) {
    fail('ASSIGNMENT_PACKET_SCHEMA_MISMATCH');
  }
  exactKeys(work.packet,[
    'schema','kind','source_sha','command','required_paths','output_path',
  ],'ASSIGNMENT_PACKET');
  if (work.packet.kind!=='pure-candidate') fail('ASSIGNMENT_PACKET_KIND_INVALID');
  if (typeof work.packet.source_sha!=='string' || !/^[0-9a-f]{40}$/.test(work.packet.source_sha)) {
    fail('ASSIGNMENT_SOURCE_SHA_INVALID');
  }
  if (!Array.isArray(work.packet.command) || work.packet.command.length===0
    || work.packet.command.some(part=>typeof part!=='string' || part.length===0)) {
    fail('ASSIGNMENT_COMMAND_INVALID');
  }
  if (!Array.isArray(work.packet.required_paths) || work.packet.required_paths.length===0
    || work.packet.required_paths.some(candidate=>!validPath(candidate))) {
    fail('ASSIGNMENT_REQUIRED_PATHS_INVALID');
  }
  if (new Set(work.packet.required_paths).size!==work.packet.required_paths.length) {
    fail('ASSIGNMENT_REQUIRED_PATHS_DUPLICATE');
  }
  if (!validPath(work.packet.output_path)) fail('ASSIGNMENT_OUTPUT_PATH_INVALID');
  if (!Array.isArray(value.files) || value.files.length===0) fail('ASSIGNMENT_FILES_INVALID');

  const seen=new Set();
  for (const file of value.files) {
    exactKeys(file,['path','mode','sha256','content_base64'],'ASSIGNMENT_FILE');
    if (!validPath(file.path)) fail('ASSIGNMENT_FILE_PATH_INVALID');
    if (seen.has(file.path)) fail('ASSIGNMENT_FILE_PATH_DUPLICATE');
    seen.add(file.path);
    if (!['100644','100755'].includes(file.mode)) fail('ASSIGNMENT_FILE_MODE_INVALID');
    if (typeof file.sha256!=='string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      fail('ASSIGNMENT_FILE_SHA256_INVALID');
    }
    const bytes=decodeBase64(file.content_base64);
    if (sha256(bytes)!==file.sha256) fail('ASSIGNMENT_FILE_DIGEST_MISMATCH');
  }
  for (const required of work.packet.required_paths) {
    if (!seen.has(required)) fail(`ASSIGNMENT_REQUIRED_FILE_MISSING:${required}`);
  }
  return value;
}

export function assignmentFile(pathname,bytes,mode='100644') {
  const data=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
  return {
    path:pathname,
    mode,
    sha256:sha256(data),
    content_base64:data.toString('base64'),
  };
}

export function buildAssignment(work,files) {
  return validateAssignment({
    schema:ASSIGNMENT_SCHEMA,
    work:structuredClone(work),
    files:files.map(file=>structuredClone(file)),
  });
}

export function encodeAssignment(assignment) {
  validateAssignment(assignment);
  return Buffer.from(`${JSON.stringify(assignment,null,2)}\n`,'utf8');
}

function listFiles(root,prefix='') {
  const found=[];
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

export function materializeAssignment(assignment,root) {
  validateAssignment(assignment);
  mkdirSync(root,{recursive:true});
  if (readdirSync(root).length!==0) fail('ASSIGNMENT_WORKSPACE_NOT_EMPTY');
  for (const file of assignment.files) {
    const absolute=join(root,...file.path.split('/'));
    mkdirSync(dirname(absolute),{recursive:true});
    const bytes=decodeBase64(file.content_base64);
    writeFileSync(absolute,bytes,{flag:'wx'});
    chmodSync(absolute,file.mode==='100755'?0o755:0o644);
  }
  const expected=assignment.files.map(file=>file.path).sort();
  const actual=listFiles(root).sort();
  if (JSON.stringify(actual)!==JSON.stringify(expected)) fail('ASSIGNMENT_WORKSPACE_MEMBERSHIP_MISMATCH');
  return actual;
}

export function assignmentSha256(bytes) {
  return sha256(bytes);
}

export function validateCandidate(value,assignment,assignmentBytes) {
  validateAssignment(assignment);
  exactKeys(value,[
    'schema','assignment_sha256','obligation_id','run_id','claimed_revision',
    'output_path','output_sha256','output_base64',
  ],'CANDIDATE');
  if (value.schema!==CANDIDATE_SCHEMA) fail('CANDIDATE_SCHEMA_MISMATCH');
  if (value.assignment_sha256!==assignmentSha256(assignmentBytes)) fail('CANDIDATE_ASSIGNMENT_MISMATCH');
  if (value.obligation_id!==assignment.work.id) fail('CANDIDATE_OBLIGATION_MISMATCH');
  if (value.run_id!==assignment.work.run_id) fail('CANDIDATE_RUN_MISMATCH');
  if (value.claimed_revision!==assignment.work.claimed_revision) fail('CANDIDATE_REVISION_MISMATCH');
  if (value.output_path!==assignment.work.packet.output_path) fail('CANDIDATE_OUTPUT_PATH_MISMATCH');
  if (typeof value.output_sha256!=='string' || !/^[0-9a-f]{64}$/.test(value.output_sha256)) {
    fail('CANDIDATE_OUTPUT_SHA256_INVALID');
  }
  const bytes=decodeBase64(value.output_base64);
  if (sha256(bytes)!==value.output_sha256) fail('CANDIDATE_OUTPUT_DIGEST_MISMATCH');
  return value;
}

export function runAssignment(assignmentPath,workspace,candidatePath) {
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
  if (!existsSync(outputFile) || lstatSync(outputFile).isSymbolicLink() || !lstatSync(outputFile).isFile()) {
    fail('ASSIGNMENT_OUTPUT_MISSING');
  }
  const output=readFileSync(outputFile);
  const candidate={
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
    console.error('usage: contract.mjs run <assignment.json> <workspace> <candidate.json>');
    process.exit(2);
  }
}
