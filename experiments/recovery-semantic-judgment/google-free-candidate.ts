import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';

const sha256=value=>createHash('sha256').update(value).digest('hex');

function parseArgs(argv){
  const values=new Map();
  for(let index=0;index<argv.length;index+=2){
    const key=argv[index], value=argv[index+1];
    if(!key?.startsWith('--') || value===undefined) throw new Error('SEMANTIC_AGENT_ARGUMENT_INVALID');
    values.set(key.slice(2),value);
  }
  for(const key of ['prompt','schema','candidate','provenance']){
    if(!values.get(key)) throw new Error(`SEMANTIC_AGENT_${key.toUpperCase()}_REQUIRED`);
  }
  return Object.fromEntries(values);
}

const args=parseArgs(process.argv.slice(2));
if(process.env.GITHUB_TOKEN) throw new Error('SEMANTIC_AGENT_GITHUB_TOKEN_FORBIDDEN');
if(process.env.OVERCENTER_DATABASE_URL || process.env.OVERCENTER_AUTHORITY_DATABASE){
  throw new Error('SEMANTIC_AGENT_AUTHORITY_FORBIDDEN');
}
if(process.env.OVERCENTER_REASONING_CREDENTIAL_SOURCE!=='gcp-api-keys-via-github-oidc'){
  throw new Error('SEMANTIC_AGENT_CREDENTIAL_SOURCE_INVALID');
}
if(process.env.OVERCENTER_REASONING_BILLING_OBSERVATION_SOURCE!=='google-cloud-billing-api'){
  throw new Error('SEMANTIC_AGENT_BILLING_SOURCE_INVALID');
}
if(process.env.OVERCENTER_REASONING_BILLING_ENABLED!=='false'){
  throw new Error('SEMANTIC_AGENT_BILLING_ENABLED');
}
const apiKey=process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if(!apiKey) throw new Error('SEMANTIC_AGENT_GOOGLE_KEY_REQUIRED');

const promptBytes=readFileSync(args.prompt);
const schema=JSON.parse(readFileSync(args.schema,'utf8'));
const [{generateText,Output,jsonSchema},{createGoogleGenerativeAI}]=await Promise.all([
  import('ai'),
  import('@ai-sdk/google'),
]);
const google=createGoogleGenerativeAI({apiKey});
const result=await generateText({
  model:google('gemini-3.8-flash'),
  output:Output.object({
    name:'RecoverySemanticDecisions',
    description:'Semantic interpretation choices for ambiguous-effect recovery. No provider coordinates or settlement claims.',
    schema:jsonSchema(schema),
  }),
  prompt:promptBytes.toString('utf8'),
});

const candidateBytes=Buffer.from(JSON.stringify(result.output)+'\n');
writeFileSync(args.candidate,candidateBytes,{flag:'wx'});
writeFileSync(args.provenance,JSON.stringify({
  schema:'overcenter-recovery-semantic-model-provenance/v1',
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
  input_scope:'semantic-interpretations-only',
  usage:result.usage,
},null,2)+'\n',{flag:'wx'});
