import assert from 'node:assert/strict';
import test from 'node:test';

import {reasoningModel,reasoningRoute} from '../src/reasoning-model.ts';

test('default reasoning stays behind AI Gateway',async()=>{
  assert.deepEqual(reasoningRoute('default'),{
    profile:'default',
    transport:'ai-gateway',
    provider:'vercel.ai-gateway',
    model_id:'google/gemini-3.8-flash',
    gateway_used:true,
  });

  const selection=await reasoningModel('default');
  assert.equal(selection.model,'google/gemini-3.8-flash');
});

test('google-free uses the direct Google provider without changing the model contract',async()=>{
  let observedKey:string|undefined;
  let observedModel:string|undefined;
  const sentinel={kind:'direct-google-model'};

  const selection=await reasoningModel('google-free',{
    env:{GOOGLE_GENERATIVE_AI_API_KEY:'test-key'},
    loadGoogle:async()=>({
      createGoogleGenerativeAI:({apiKey})=>{
        observedKey=apiKey;
        return modelId=>{
          observedModel=modelId;
          return sentinel;
        };
      },
    }),
  });

  assert.equal(observedKey,'test-key');
  assert.equal(observedModel,'gemini-3.8-flash');
  assert.equal(selection.model,sentinel);
  assert.deepEqual({...selection,model:undefined},{
    profile:'google-free',
    transport:'google-generative-ai',
    provider:'google.generative-ai',
    model_id:'gemini-3.8-flash',
    gateway_used:false,
    model:undefined,
  });
});

test('google-free fails closed when the direct Google credential is absent',async()=>{
  let loaded=false;
  await assert.rejects(
    reasoningModel('google-free',{
      env:{},
      loadGoogle:async()=>{
        loaded=true;
        throw new Error('must not load');
      },
    }),
    /GOOGLE_GENERATIVE_AI_API_KEY_REQUIRED/,
  );
  assert.equal(loaded,false);
});

test('unknown reasoning profiles do not silently adapt',()=>{
  assert.throws(()=>reasoningRoute('google'),/REASONING_PROFILE_UNSUPPORTED/);
});
