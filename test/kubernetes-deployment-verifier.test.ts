import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KUBERNETES_DEPLOYMENT_GET_OPERATION_ID,
  verifyCertifiedKubernetesDeployment,
  type KubernetesDeploymentExpectation,
  type KubernetesDeploymentGetRead,
} from '../src/providers/kubernetes-deployment.ts';

const expectation:KubernetesDeploymentExpectation={
  authority_id:'kind:test',
  namespace:'staging',
  name:'api',
  container_name:'pause',
  image:'registry.example/pause@sha256:'+'1'.repeat(64),
  obligation_key:'2'.repeat(64),
  effect_identity:'3'.repeat(64),
};

const operation={
  operation_id:KUBERNETES_DEPLOYMENT_GET_OPERATION_ID,
  outcomes:[{
    status:'200',
    schema:{
      type:'object',
      properties:{
        apiVersion:{type:'string'},
        kind:{type:'string'},
        metadata:{
          type:'object',
          properties:{
            name:{type:'string'},
            namespace:{type:'string'},
            uid:{type:'string'},
            resourceVersion:{type:'string'},
            generation:{type:'integer'},
            annotations:{type:'object'},
          },
        },
        spec:{
          type:'object',
          properties:{
            replicas:{type:'integer'},
            template:{
              type:'object',
              properties:{
                spec:{
                  type:'object',
                  properties:{
                    containers:{
                      type:'array',
                      items:{
                        type:'object',
                        properties:{
                          name:{type:'string'},
                          image:{type:'string'},
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        status:{
          type:'object',
          properties:{
            observedGeneration:{type:'integer'},
            availableReplicas:{type:'integer'},
          },
        },
      },
    },
  }],
};

function read(overrides:Record<string,unknown>={}):KubernetesDeploymentGetRead {
  const value={
    apiVersion:'apps/v1',
    kind:'Deployment',
    metadata:{
      name:expectation.name,
      namespace:expectation.namespace,
      uid:'uid-a',
      resourceVersion:'42',
      generation:7,
      annotations:{
        'overcenter.dev/obligation-key':expectation.obligation_key,
        'overcenter.dev/effect-identity':expectation.effect_identity,
      },
    },
    spec:{
      replicas:3,
      template:{
        spec:{
          containers:[{
            name:expectation.container_name,
            image:expectation.image,
          }],
        },
      },
    },
    status:{
      observedGeneration:7,
      availableReplicas:3,
    },
    ...overrides,
  };
  return {
    operation,
    observation:{
      contract:{
        provider:'kubernetes',
        api_version:'v1',
        operation_id:KUBERNETES_DEPLOYMENT_GET_OPERATION_ID,
        schema_sha256:'a'.repeat(64),
      },
      authority_id:expectation.authority_id,
      observer:{kind:'test',id:'deployment'},
      observed_at:'2026-09-20T21:00:00.000Z',
      request:{
        namespace:expectation.namespace,
        name:expectation.name,
      },
      response:{},
      outcome:{
        status:200,
        visibility:'observed',
        value,
      },
    },
  };
}

test('exact healthy Deployment realization verifies',()=>{
  const result=verifyCertifiedKubernetesDeployment(expectation,read());
  assert.equal(result.state,'verified');
  if(result.state==='verified'){
    assert.equal(result.uid,'uid-a');
    assert.equal(result.resource_version,'42');
  }
});

test('healthy Deployment for another effect is rejected',()=>{
  const base=read();
  const body=structuredClone(base.observation.outcome.value) as any;
  body.metadata.annotations['overcenter.dev/effect-identity']='4'.repeat(64);
  base.observation.outcome.value=body;

  const result=verifyCertifiedKubernetesDeployment(expectation,base);
  assert.deepEqual(
    {state:result.state,reason:result.reason},
    {
      state:'rejected',
      reason:'KUBERNETES_DEPLOYMENT_REALIZATION_IDENTITY_MISMATCH',
    },
  );
});

test('same effect identity cannot substitute another semantic obligation',()=>{
  const base=read();
  const body=structuredClone(base.observation.outcome.value) as any;
  body.metadata.annotations['overcenter.dev/obligation-key']='5'.repeat(64);
  base.observation.outcome.value=body;

  const result=verifyCertifiedKubernetesDeployment(expectation,base);
  assert.equal(result.state,'rejected');
  assert.equal(result.reason,'KUBERNETES_DEPLOYMENT_REALIZATION_IDENTITY_MISMATCH');
});

test('stale generation or incomplete readiness is rejected',()=>{
  for(const mutate of [
    (body:any)=>{body.status.observedGeneration=6;},
    (body:any)=>{body.status.availableReplicas=2;},
  ]){
    const candidate=read();
    const body=structuredClone(candidate.observation.outcome.value) as any;
    mutate(body);
    candidate.observation.outcome.value=body;
    const result=verifyCertifiedKubernetesDeployment(expectation,candidate);
    assert.equal(result.state,'rejected');
    assert.equal(result.reason,'KUBERNETES_DEPLOYMENT_NOT_HEALTHY_CURRENT_GENERATION');
  }
});

test('authority or request-coordinate mismatch is indeterminate',()=>{
  const wrongAuthority=read();
  wrongAuthority.observation.authority_id='kind:other';
  assert.equal(
    verifyCertifiedKubernetesDeployment(expectation,wrongAuthority).state,
    'indeterminate',
  );

  const wrongName=read();
  wrongName.observation.request.name='other';
  assert.equal(
    verifyCertifiedKubernetesDeployment(expectation,wrongName).state,
    'indeterminate',
  );
});
