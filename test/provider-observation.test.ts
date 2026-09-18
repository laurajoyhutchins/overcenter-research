import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateResponseSlice,
  type SchemaResolver,
  type StructuralOperation,
} from '../src/provider-observation/response-slice.ts';

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
    outcome:{
      status:200,
      visibility:'observed' as const,
      value:{id:42},
    },
  };

  const {validateObservationSlice}=await import('../src/provider-observation/response-slice.ts');
  const certified=validateObservationSlice(operation,observation,[{path:'id'}]);

  assert.equal(certified.structural_validation.operation_id,'test/get');
  assert.equal(certified.structural_validation.schema_sha256,'a'.repeat(64));
  assert.deepEqual(certified.structural_validation.validated_paths,['id']);
});
