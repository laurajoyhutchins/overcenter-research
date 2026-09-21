export type ReasoningProfile='default'|'google-free';

export type ReasoningRoute={
  profile:ReasoningProfile;
  transport:'ai-gateway'|'google-generative-ai';
  provider:string;
  model_id:string;
  gateway_used:boolean;
};

export type ReasoningSelection=ReasoningRoute&{model:unknown};

type GoogleProviderModule={
  createGoogleGenerativeAI(options:{apiKey:string}):(modelId:string)=>unknown;
};

const ROUTES:Record<ReasoningProfile,Omit<ReasoningRoute,'profile'>>={
  default:{
    transport:'ai-gateway',
    provider:'vercel.ai-gateway',
    model_id:'google/gemini-3.8-flash',
    gateway_used:true,
  },
  'google-free':{
    transport:'google-generative-ai',
    provider:'google.generative-ai',
    model_id:'gemini-3.8-flash',
    gateway_used:false,
  },
};

export function reasoningRoute(profile:string):ReasoningRoute {
  if (profile!=='default' && profile!=='google-free') throw new Error('REASONING_PROFILE_UNSUPPORTED');
  return {profile,...ROUTES[profile]};
}

export async function reasoningModel(
  profile:ReasoningProfile,
  options:{
    env?:Readonly<Record<string,string|undefined>>;
    loadGoogle?:()=>Promise<GoogleProviderModule>;
  }={},
):Promise<ReasoningSelection> {
  const route=reasoningRoute(profile);
  if (route.gateway_used) return {...route,model:route.model_id};

  const apiKey=(options.env??process.env).GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY_REQUIRED');

  const module=await (options.loadGoogle??(()=>import('@ai-sdk/google')))();
  const google=module.createGoogleGenerativeAI({apiKey});
  return {...route,model:google(route.model_id)};
}
