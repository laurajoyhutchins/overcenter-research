import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateObservationSlice,
  validateResponseSlice,
  type SchemaResolver,
  type StructuralOperation,
} from '../src/observation/response-slice.ts';
import {
  validateProviderObservationEnvelope,
} from '../src/observation/provider.ts';

test('production structural validator follows provider-supplied local refs', () => {
  const schemas:Record<string,unknown>={
    '#/Object':{
      type:'object',
      properties:{
        metadata:{$ref:'#/Metadata'},
      },
    },
    '#/Metadata':{
      type:'object',
      properties:{
        uid:{type:'string'},
      },
    },
  };
  const resolveRef:SchemaResolver=ref=>{
    const schema=schemas[ref];
    if (!schema) throw new Error(`TEST_REF_NOT_FOUND:${ref}`);
    return schema;
  };
  const operation:StructuralOperation={
    operation_id:'test/get',
    outcomes:[{status:'200',schema:{$ref:'#/Object'}}],
  };

  const result=validateResponseSlice(
    operation,
    '200',
    {metadata:{uid:'entity-1'}},
    [{path:'metadata.uid'}],
    resolveRef,
  );

  assert.deepEqual(result.validated_paths,['metadata.uid']);
});

test('production structural validator fails closed on a ref cycle', () => {
  const schemas:Record<string,unknown>={
    '#/A':{$ref:'#/B'},
    '#/B':{$ref:'#/A'},
  };
  const resolveRef:SchemaResolver=ref=>{
    const schema=schemas[ref];
    if (!schema) throw new Error(`TEST_REF_NOT_FOUND:${ref}`);
    return schema;
  };
  const operation:StructuralOperation={
    operation_id:'test/get',
    outcomes:[{status:'200',schema:{$ref:'#/A'}}],
  };

  assert.throws(
    ()=>validateResponseSlice(
      operation,
      '200',
      {metadata:{uid:'entity-1'}},
      [{path:'metadata.uid'}],
      resolveRef,
    ),
    /RESPONSE_SLICE_SCHEMA_REF_CYCLE/,
  );
});

test('production structural validator binds certificate to operation and schema digest', () => {
  const operation:StructuralOperation={
    operation_id:'test/get',
    outcomes:[{
      status:'200',
      schema:{
        type:'object',
        properties:{id:{type:'integer'}},
      },
    }],
  };
  const observation={
    contract:{
      provider:'test',
      api_version:'v1',
      operation_id:'test/get',
      schema_sha256:'a'.repeat(64),
    },
    observer:{kind:'test',id:'provider-observation'},
    observed_at:'2026-09-19T00:00:00.000Z',
    request:{},
    response:{},
    outcome:{
      status:200,
      visibility:'observed' as const,
      value:{id:42},
    },
  };

  const certified=validateObservationSlice(operation,observation,[{path:'id'}]);

  assert.equal(certified.structural_validation.operation_id,'test/get');
  assert.equal(certified.structural_validation.schema_sha256,'a'.repeat(64));
  assert.deepEqual(certified.structural_validation.validated_paths,['id']);

  const recertified=validateObservationSlice(operation,certified,[{path:'id'}]);
  assert.equal(recertified.structural_validation.operation_id,'test/get');
  assert.deepEqual(recertified.structural_validation.validated_paths,['id']);
});


test('provider observation envelope rejects undeclared outer fields',()=>{
  const observation={
    contract:{
      provider:'github',
      api_version:'2026-03-10',
      operation_id:'repos/get',
      schema_sha256:'a'.repeat(64),
    },
    observer:{kind:'git-kernel',id:'test'},
    observed_at:'2026-09-19T00:00:00.000Z',
    request:{path:'/repos/o/r'},
    response:{},
    outcome:{status:200,visibility:'observed',value:{}},
    surprise:true,
  };
  assert.throws(
    ()=>validateProviderObservationEnvelope(observation),
    /PROVIDER_OBSERVATION_SHAPE_INVALID:UNKNOWN_FIELD:surprise/,
  );
});

test('provider-specific outer fields require explicit declaration',()=>{
  const observation={
    contract:{
      provider:'kubernetes',
      api_version:'v1',
      operation_id:'listCoreV1NamespacedConfigMap',
      schema_sha256:'a'.repeat(64),
    },
    observer:{kind:'test',id:'kubernetes'},
    observed_at:'2026-09-19T00:00:00.000Z',
    request:{namespace:'proof',continue_token:null,limit:100},
    response:{},
    outcome:{status:200,visibility:'observed',value:{}},
    authority_id:'kind:test-cluster',
  };
  assert.throws(()=>validateProviderObservationEnvelope(observation));
  assert.doesNotThrow(()=>validateProviderObservationEnvelope(
    observation,
    {
      requiredTopLevelExtensions:{
        authority_id:'non-empty-string',
      },
    },
  ));
  const {authority_id:_,...missing}=observation;
  assert.throws(
    ()=>validateProviderObservationEnvelope(
      missing,
      {
        requiredTopLevelExtensions:{
          authority_id:'non-empty-string',
        },
      },
    ),
    /PROVIDER_OBSERVATION_SHAPE_INVALID:MISSING_FIELD:authority_id/,
  );
  assert.throws(
    ()=>validateProviderObservationEnvelope(
      {...observation,authority_id:''},
      {
        requiredTopLevelExtensions:{
          authority_id:'non-empty-string',
        },
      },
    ),
    /PROVIDER_OBSERVATION_EXTENSION_INVALID:authority_id/,
  );
});


test('conditional revalidation provenance is explicit and closed',()=>{
  const base={
    contract:{
      provider:'github',
      api_version:'2026-03-10',
      operation_id:'repos/get',
      schema_sha256:'a'.repeat(64),
    },
    observer:{kind:'git-kernel',id:'conditional-proof'},
    observed_at:'2026-09-19T00:00:01.000Z',
    request:{path:'/repos/o/r'},
    response:{etag:'"abc"'},
    outcome:{status:200,visibility:'observed' as const,value:{}},
    revalidated_from:{
      observed_at:'2026-09-19T00:00:00.000Z',
      etag:'"abc"',
    },
  };
  assert.doesNotThrow(()=>validateProviderObservationEnvelope(base));
  assert.throws(
    ()=>validateProviderObservationEnvelope({
      ...base,
      revalidated_from:{...base.revalidated_from,surprise:true},
    }),
    /PROVIDER_OBSERVATION_REVALIDATION_SHAPE_INVALID:UNKNOWN_FIELD:surprise/,
  );
});


test('provider envelope rejects unsafe status and NUL-bearing identity strings',()=>{
  const base={
    contract:{
      provider:'github',
      api_version:'2026-03-10',
      operation_id:'repos/get',
      schema_sha256:'a'.repeat(64),
    },
    observer:{kind:'git-kernel',id:'red-team'},
    observed_at:'2026-09-19T00:00:00.000Z',
    request:{},
    response:{},
    outcome:{status:200,visibility:'observed' as const,value:{}},
  };
  assert.throws(
    ()=>validateProviderObservationEnvelope({
      ...base,
      outcome:{...base.outcome,status:Number.MAX_SAFE_INTEGER+1},
    }),
    /PROVIDER_OBSERVATION_STATUS_INVALID/,
  );
  assert.throws(
    ()=>validateProviderObservationEnvelope({
      ...base,
      contract:{...base.contract,operation_id:'repos/get\0forged'},
    }),
    /PROVIDER_OBSERVATION_OPERATION_ID_INVALID/,
  );
});
