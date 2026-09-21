import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';

const [rawPath,promptPath,candidatePath,provenancePath]=process.argv.slice(2);
if (!rawPath || !promptPath || !candidatePath || !provenancePath) {
  throw new Error('usage: local-model-normalize.mjs <raw> <prompt> <candidate> <provenance>');
}

const sha256=value=>createHash('sha256').update(value).digest('hex');
const raw=readFileSync(rawPath);
const clean=raw.toString('utf8').replace(/\x1b\[[0-9;]*m/g,'').trim();
const start=clean.indexOf('{');
const end=clean.lastIndexOf('}');
if (start<0 || end<start) throw new Error('LOCAL_MODEL_JSON_NOT_FOUND');
const value=JSON.parse(clean.slice(start,end+1));
const candidate=Buffer.from(JSON.stringify(value)+'\n');
writeFileSync(candidatePath,candidate,{flag:'wx'});

const required=name=>{
  const value=process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};
const provenance={
  schema:'overcenter-autonomy-model-candidate-provenance/v1',
  provider:'local-qwen2.5-coder-0.5b',
  transport:'offline-llama.cpp',
  repository_mutation_observed:false,
  prompt_sha256:sha256(readFileSync(promptPath)),
  candidate_sha256:sha256(candidate),
  response_body_sha256:sha256(raw),
  model_id:required('MODEL_ID'),
  model_revision:required('MODEL_REVISION'),
  model_sha256:required('MODEL_SHA256'),
  runtime_id:required('RUNTIME_ID'),
  runtime_sha256:required('RUNTIME_SHA256'),
  network_during_inference:false,
  repository_credentials_present:false,
  checkout_readable_during_inference:false,
  worker_uid_isolated:true,
  input_scope:'synthetic-prompt-and-schema-only',
  worker_job_is_disposable:true,
};
writeFileSync(provenancePath,JSON.stringify(provenance,null,2)+'\n',{flag:'wx'});
