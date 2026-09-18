import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateObservationStructure,
  validateStructure,
} from './structural-decoder.ts';
import type {
  ObservationOperation,
  RawObservation,
} from './openapi.ts';

test('nested required object validates structurally without imposing semantic format rules', () => {
  const schema = {
    type: 'object',
    required: ['id', 'owner'],
    properties: {
      id: { type: 'integer' },
      owner: {
        type: 'object',
        required: ['login'],
        properties: {
          login: { type: 'string', pattern: '^[a-z]+$' },
        },
      },
    },
  };

  assert.deepEqual(validateStructure(schema, {
    id: 42,
    owner: { login: 'UPPERCASE-is-still-structurally-a-string' },
  }), {
    state: 'VALID',
    problems: [],
  });
});

test('missing required property and wrong nested type fail closed with exact path evidence', () => {
  const schema = {
    type: 'object',
    required: ['owner'],
    properties: {
      owner: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' },
        },
      },
    },
  };

  assert.deepEqual(validateStructure(schema, {}), {
    state: 'INVALID',
    problems: [{
      path: '$.owner',
      reason: 'STRUCTURAL_REQUIRED_PROPERTY_MISSING',
    }],
  });

  assert.deepEqual(validateStructure(schema, { owner: { id: '42' } }), {
    state: 'INVALID',
    problems: [{
      path: '$.owner.id',
      reason: 'STRUCTURAL_TYPE_MISMATCH:integer',
    }],
  });
});

test('additionalProperties false and array item structure are enforced', () => {
  const schema = {
    type: 'object',
    required: ['items'],
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer' } },
        },
      },
    },
  };

  assert.equal(validateStructure(schema, {
    items: [{ id: 1 }],
    invented: true,
  }).state, 'INVALID');

  assert.deepEqual(validateStructure(schema, {
    items: [{ id: 'one' }],
  }), {
    state: 'INVALID',
    problems: [{
      path: '$.items[0].id',
      reason: 'STRUCTURAL_TYPE_MISMATCH:integer',
    }],
  });
});

test('anyOf and oneOf preserve structural alternatives rather than picking a favorite branch', () => {
  const nullable = {
    anyOf: [
      { type: 'string' },
      { type: 'null' },
    ],
  };
  assert.equal(validateStructure(nullable, 'value').state, 'VALID');
  assert.equal(validateStructure(nullable, null).state, 'VALID');
  assert.equal(validateStructure(nullable, 7).state, 'INVALID');

  const exactlyOne = {
    oneOf: [
      { type: 'number' },
      { type: 'integer' },
    ],
  };
  assert.deepEqual(validateStructure(exactlyOne, 1), {
    state: 'INVALID',
    problems: [{
      path: '$',
      reason: 'STRUCTURAL_ONEOF_MATCH_COUNT:2',
    }],
  });
});

test('unsupported schema constructs never degrade into VALID', () => {
  assert.deepEqual(validateStructure({ $ref: '#/components/schemas/foo' }, {}), {
    state: 'UNSUPPORTED',
    problems: [{
      path: '$',
      reason: 'STRUCTURAL_SCHEMA_REF_UNRESOLVED',
    }],
  });

  assert.equal(validateStructure({
    type: 'object',
    patternProperties: { '^x-': { type: 'string' } },
  }, { 'x-test': 'yes' }).state, 'UNSUPPORTED');

  assert.equal(validateStructure({
    type: 'array',
    contains: { type: 'integer' },
  }, [1]).state, 'UNSUPPORTED');
});

const operation: ObservationOperation = {
  provider: 'github',
  api_version: '2026-03-10',
  method: 'GET',
  path_template: '/repos/{owner}/{repo}',
  operation_id: 'repos/get',
  parameters: [],
  outcomes: [{
    status: '200',
    description: 'ok',
    schema: {
      type: 'object',
      required: ['id', 'full_name'],
      properties: {
        id: { type: 'integer' },
        full_name: { type: 'string' },
      },
    },
  }],
  github_extensions: {},
};

function observation(value: unknown): RawObservation {
  return {
    contract: {
      provider: 'github',
      api_version: '2026-03-10',
      operation_id: 'repos/get',
      schema_sha256: 'a'.repeat(64),
    },
    observer: { kind: 'test', id: 'structural-test' },
    observed_at: '2026-09-18T18:00:00.000Z',
    request: {
      method: 'GET',
      path_template: '/repos/{owner}/{repo}',
      path: '/repos/acme/widget',
      parameters: { owner: 'acme', repo: 'widget' },
      headers: {},
      authorization: 'none',
    },
    response: {
      date: null,
      etag: null,
      link: null,
      request_id: null,
    },
    outcome: {
      status: 200,
      visibility: 'observed',
      value,
    },
  };
}

test('observation validation binds response structure to exact operation identity', () => {
  assert.equal(validateObservationStructure(operation, observation({
    id: 42,
    full_name: 'acme/widget',
  })).state, 'VALID');

  const wrong = observation({ id: 42, full_name: 'acme/widget' });
  wrong.contract.operation_id = 'pulls/get';
  assert.deepEqual(validateObservationStructure(operation, wrong), {
    state: 'INVALID',
    problems: [{
      path: '$',
      reason: 'STRUCTURAL_OPERATION_IDENTITY_MISMATCH',
    }],
  });
});

test('observation validation rejects malformed bodies and refuses undocumented schema gaps', () => {
  assert.deepEqual(validateObservationStructure(operation, observation({
    id: 'forty-two',
    full_name: 'acme/widget',
  })), {
    state: 'INVALID',
    problems: [{
      path: '$.id',
      reason: 'STRUCTURAL_TYPE_MISMATCH:integer',
    }],
  });

  const noSchema: ObservationOperation = {
    ...operation,
    outcomes: [{ status: '200', description: 'ok', schema: null }],
  };
  assert.deepEqual(validateObservationStructure(noSchema, observation({
    id: 42,
    full_name: 'acme/widget',
  })), {
    state: 'UNSUPPORTED',
    problems: [{
      path: '$',
      reason: 'STRUCTURAL_RESPONSE_SCHEMA_UNAVAILABLE',
    }],
  });
});
