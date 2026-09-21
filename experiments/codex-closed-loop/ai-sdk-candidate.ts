import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';

import {reasoningModel,type ReasoningProfile} from '../../src/reasoning-model.ts';

type Args={
  profile:ReasoningProfile;
  prompt:string;
  schema:string;
  candidate:string;
  provenance:string;
};

const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

function parseArgs(argv:string[]):Args {
  const values=new Map<string,string>();
  for (let index=0;index<argv.length;index+=2) {
    const key=argv[index];
    const value=argv[index+1];
    if (!key?.startsWith('--') || value===undefined) throw new Error('AI_SDK_ARGUMENT_INVALID');
    values.set(key.slice(2),value);
  }
  const profile=values.get('profile');
  if (profile!=='default' && profile!=='google-free') throw new Error('AI_SDK_PROFILE_INVALID');
  for (const key of ['prompt','schema','candidate','provenance']) {
    if (!values.get(key)) throw new Error(`AI_SDK_${key.toUpperCase()}_REQUIRED`);
  }
  return {
    profile,
    prompt:values.get('prompt')!,
    schema:values.get('schema')!,
    candidate:values.get('candidate')!,
    provenance:values.get('provenance')!,
  };
}

const args=parseArgs(process.argv.slice(2));
const credentialSource=process.env.OVERCENTER_REASONING_CREDENTIAL_SOURCE??null;
if (args.profile==='google-free' && credentialSource!=='gcp-api-keys-via-github-oidc') {
  throw new Error('AI_SDK_GOOGLE_FREE_CREDENTIAL_SOURCE_INVALID');
}
if (process.env.GITHUB_TOKEN) throw new Error('AI_SDK_GITHUB_TOKEN_FORBIDDEN');
if (process.env.OVERCENTER_DATABASE_URL || process.env.OVERCENTER_AUTHORITY_DATABASE) {
  throw new Error('AI_SDK_OVERCENTER_AUTHORITY_FORBIDDEN');
}

const promptBytes=readFileSync(args.prompt);
const schema=JSON.parse(readFileSync(args.schema,'utf8')) as Record<string,unknown>;
const selection=await reasoningModel(args.profile);
const {generateText,Output,jsonSchema}=await import('ai');

const result=await generateText({
  model:selection.model as any,
  output:Output.object({
    name:'OvercenterAutonomyCandidate',
    description:'Exact candidate bytes for the synthetic autonomy sandbox objective.',
    schema:jsonSchema(schema),
  }),
  prompt:promptBytes.toString('utf8'),
});

const responseBytes=Buffer.from(JSON.stringify(result.output));
const candidateBytes=Buffer.from(`${JSON.stringify(result.output)}\n`);
writeFileSync(args.candidate,candidateBytes,{flag:'wx'});

const provenance={
  schema:'overcenter-autonomy-model-candidate-provenance/v1',
  provider:selection.provider,
  transport:'ai-sdk',
  routing_profile:selection.profile,
  model_id:selection.model_id,
  gateway_used:selection.gateway_used,
  credential_source:credentialSource,
  repository_mutation_observed:false,
  prompt_sha256:sha256(promptBytes),
  candidate_sha256:sha256(candidateBytes),
  response_body_sha256:sha256(responseBytes),
  network_during_inference:true,
  reasoning_api_credential_present:true,
  repository_credentials_present:false,
  checkout_readable_during_inference:false,
  overcenter_authority_present:false,
  project_provider_mutation_authority_present:false,
  worker_uid_isolated:true,
  input_scope:'synthetic-prompt-and-schema-only',
  worker_job_is_disposable:true,
  usage:result.usage,
};
writeFileSync(args.provenance,`${JSON.stringify(provenance,null,2)}\n`,{flag:'wx'});
