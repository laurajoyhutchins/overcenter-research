import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateResponseSlice,
  type SchemaResolver,
  type StructuralOperation,
} from './response-slice.ts';

test('shared structural validator follows provider-supplied local refs', () => {
  const schemas: Record<string, unknown> = {
    '#/Object': {
      type: 'object',
      properties: {
        metadata: { $ref: '#/Metadata' },
      },
    },
    '#/Metadata': {
      type: 'object',
      properties: {
        uid: { type: 'string' },
      },
    },
  };
  const resolveRef: SchemaResolver = ref => {
    const schema = schemas[ref];
    if (!schema) throw new Error(`TEST_REF_NOT_FOUND:${ref}`);
    return schema;
  };
  const operation: StructuralOperation = {
    operation_id: 'test/get',
    outcomes: [{ status: '200', schema: { $ref: '#/Object' } }],
  };

  const result = validateResponseSlice(
    operation,
    '200',
    { metadata: { uid: 'entity-1' } },
    [{ path: 'metadata.uid' }],
    resolveRef,
  );

  assert.deepEqual(result.validated_paths, ['metadata.uid']);
});

test('shared structural validator fails closed on a ref cycle', () => {
  const schemas: Record<string, unknown> = {
    '#/A': { $ref: '#/B' },
    '#/B': { $ref: '#/A' },
  };
  const resolveRef: SchemaResolver = ref => {
    const schema = schemas[ref];
    if (!schema) throw new Error(`TEST_REF_NOT_FOUND:${ref}`);
    return schema;
  };
  const operation: StructuralOperation = {
    operation_id: 'test/get',
    outcomes: [{ status: '200', schema: { $ref: '#/A' } }],
  };

  assert.throws(
    () => validateResponseSlice(
      operation,
      '200',
      { metadata: { uid: 'entity-1' } },
      [{ path: 'metadata.uid' }],
      resolveRef,
    ),
    /RESPONSE_SLICE_SCHEMA_REF_CYCLE/,
  );
});
