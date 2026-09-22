import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';

const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

function parseArgs(argv:string[]) {
  const values=new Map<string,string>();
  for (let index=0;index<argv.length;index+=2) {
    const key=argv[index];
    const value=argv[index+1];
    if (!key?.startsWith('--') || value===undefined) {
      throw new Error('RESIDUE_MODEL_ARGUMENT_INVALID');
    }
    values.set(key.slice(2),value);
  }
  for (const key of ['prompt','schema','candidate','provenance']) {
    if (!values.get(key)) throw new Error(`RESIDUE_MODEL_${key.toUpperCase()}_REQUIRED`);
  }
  return Object.fromEntries(values) as Record<string,string>;
}

const input=parseArgs(process.argv.slice(2));
if (process.env.GITHUB_TOKEN) throw new Error('RESIDUE_MODEL_GITHUB_TOKEN_FORBIDDEN');
if (process.env.OVERCENTER_DATABASE_URL || process.env.OVERCENTER_AUTHORITY_DATABASE) {
  throw new Error('RESIDUE_MODEL_AUTHORITY_FORBIDDEN');
}
if (process.env.OVERCENTER_REASONING_CREDENTIAL_SOURCE!=='gcp-api-keys-via-github-oidc') {
  throw new Error('RESIDUE_MODEL_CREDENTIAL_SOURCE_INVALID');
}
if (process.env.OVERCENTER_REASONING_BILLING_OBSERVATION_SOURCE!=='google-cloud-billing-api') {
  throw new Error('RESIDUE_MODEL_BILLING_SOURCE_INVALID');
}
if (process.env.OVERCENTER_REASONING_BILLING_ENABLED!=='false') {
  throw new Error('RESIDUE_MODEL_BILLING_ENABLED');
}
const apiKey=process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!apiKey) throw new Error('RESIDUE_MODEL_GOOGLE_KEY_REQUIRED');

const promptBytes=readFileSync(input.prompt);
const schema=JSON.parse(readFileSync(input.schema,'utf8')) as Record<string,unknown>;
const [{generateText,Output,jsonSchema},{createGoogleGenerativeAI}]=await Promise.all([
  import('ai'),
  import('@ai-sdk/google'),
]);
const google=createGoogleGenerativeAI({apiKey});
const result=await generateText({
  model:google('gemini-3.8-flash'),
  output:Output.object({
    name:'RecoveryJudgmentSearchCandidate',
    description:'Search parameters only for one ambiguous-effect recovery residue. This is not evidence or a settlement decision.',
    schema:jsonSchema(schema),
  }),
  prompt:promptBytes.toString('utf8'),
});

const candidateBytes=Buffer.from(JSON.stringify(result.output)+'\n');
writeFileSync(input.candidate,candidateBytes,{flag:'wx'});
writeFileSync(input.provenance,JSON.stringify({
  schema:'overcenter-recovery-judgment-model-provenance/v1',
  provider:'google.generative-ai',
  model_id:'gemini-3.8-flash',
  transport:'ai-sdk',
  credential_source:process.env.OVERCENTER_REASONING_CREDENTIAL_SOURCE,
  billing_project_id:process.env.OVERCENTER_REASONING_BILLING_PROJECT_ID??null,
  billing_observation_source:process.env.OVERCENTER_REASONING_BILLING_OBSERVATION_SOURCE,
  billing_enabled:false,
  prompt_sha256:sha256(promptBytes),
  candidate_sha256:sha256(candidateBytes),
  repository_credentials_present:false,
  checkout_readable_during_inference:false,
  overcenter_authority_present:false,
  provider_mutation_authority_present:false,
  input_scope:'single-public-recovery-residue-and-proposal-schema-only',
  usage:result.usage,
},null,2)+'\n',{flag:'wx'});
