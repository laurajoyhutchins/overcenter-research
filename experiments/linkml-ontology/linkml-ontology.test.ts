import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = 'experiments/linkml-ontology';
const SCHEMA = `${ROOT}/ontology.yaml`;
const TARGET = 'OntologySlice';

function invoke(command, args, { expectFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (expectFailure) {
    assert.notEqual(result.status, 0, `${command} ${args.join(' ')} unexpectedly succeeded`);
  } else {
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function validate(path, expectFailure = false) {
  return invoke('linkml-validate', ['--schema', SCHEMA, '--target-class', TARGET, path], {
    expectFailure,
  });
}

function generate(schemaPath) {
  return {
    jsonSchema: invoke('gen-json-schema', ['--top-class', TARGET, schemaPath]).stdout,
    typescript: invoke('gen-typescript', [schemaPath]).stdout,
    shacl: invoke('gen-shacl', [schemaPath]).stdout,
  };
}

function shaclEquivalent(left, right) {
  const dir = mkdtempSync(join(tmpdir(), 'overcenter-linkml-shacl-'));
  const leftPath = join(dir, 'left.ttl');
  const rightPath = join(dir, 'right.ttl');
  try {
    writeFileSync(leftPath, left);
    writeFileSync(rightPath, right);
    const result = spawnSync(
      'python3',
      [`${ROOT}/shacl-equivalent.py`, leftPath, rightPath],
      { encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    assert.ok(
      result.status === 0 || result.status === 1,
      `SHACL graph comparison failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    return result.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function semanticSettlementCheck(instance) {
  const expected = instance.settlement.semantic_key;
  return instance.settlement.evidence.every((evidence) => evidence.semantic_key === expected);
}

test('LinkML schema is valid and structural constraints distinguish hostile fixtures', () => {
  invoke('linkml-validate', [SCHEMA]);
  validate(`${ROOT}/fixtures/valid.json`);
  validate(`${ROOT}/fixtures/invalid-missing-evidence.json`, true);
  validate(`${ROOT}/fixtures/invalid-unknown-relation.json`, true);
});

test('generated projections are stable at the representation level they promise', () => {
  const first = generate(SCHEMA);
  const second = generate(SCHEMA);

  assert.equal(second.jsonSchema, first.jsonSchema);
  assert.equal(second.typescript, first.typescript);
  assert.equal(shaclEquivalent(second.shacl, first.shacl), true);

  assert.match(first.jsonSchema, /Settlement/);
  assert.match(first.typescript, /Settlement/);
  assert.match(first.shacl, /Settlement/);

  const jsonSchema = JSON.parse(first.jsonSchema);
  assert.equal(
    jsonSchema.$defs.Settlement.properties.semantic_key.type,
    'string',
    'JSON Schema must preserve string scalar type',
  );
  assert.equal(
    jsonSchema.$defs.Settlement.properties.establishes_project_truth.type,
    'boolean',
    'JSON Schema must preserve boolean scalar type',
  );
  assert.match(
    first.typescript,
    /semantic_key\s*:\s*string/,
    'TypeScript must preserve string scalar type',
  );
  assert.match(
    first.typescript,
    /establishes_project_truth\s*:\s*boolean/,
    'TypeScript must preserve boolean scalar type',
  );

  console.log(
    'projection byte stability',
    JSON.stringify({
      json_schema: second.jsonSchema === first.jsonSchema,
      typescript: second.typescript === first.typescript,
      shacl: second.shacl === first.shacl,
    }),
  );
});

test('a relation rename propagates to JSON Schema, TypeScript, and SHACL', () => {
  const original = readFileSync(SCHEMA, 'utf8');
  const needle = `      evidence:
        range: Evidence
        multivalued: true
`;
  assert.ok(original.includes(needle), 'settlement evidence slot marker changed');

  const mutated = original.replace(
    needle,
    `      proofs:
        range: Evidence
        multivalued: true
`,
  );
  const dir = mkdtempSync(join(tmpdir(), 'overcenter-linkml-relation-'));
  const path = join(dir, 'ontology.yaml');
  try {
    writeFileSync(path, original);
    const baseline = generate(path);
    writeFileSync(path, mutated);
    const changed = generate(path);
    assert.notEqual(changed.jsonSchema, baseline.jsonSchema);
    assert.notEqual(changed.typescript, baseline.typescript);
    assert.equal(shaclEquivalent(changed.shacl, baseline.shacl), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('structural validity is not semantic settlement validity', () => {
  const path = `${ROOT}/fixtures/semantic-key-mismatch.json`;

  // Deliberate negative control: LinkML accepts this because each field is
  // structurally valid. Equality across settlement/evidence semantic identity
  // remains an Overcenter semantic invariant.
  validate(path);

  const instance = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(semanticSettlementCheck(instance), false);
});

test('reports whether each projection preserves a cardinality-only change', () => {
  const original = readFileSync(SCHEMA, 'utf8');
  const needle = `      evidence:
        range: Evidence
        multivalued: true
        inlined: true
        inlined_as_list: true
        required: true
        minimum_cardinality: 1
`;
  assert.ok(original.includes(needle), 'settlement evidence cardinality marker changed');

  const mutated = original.replace(
    needle,
    needle.replace('minimum_cardinality: 1', 'minimum_cardinality: 2'),
  );
  const dir = mkdtempSync(join(tmpdir(), 'overcenter-linkml-cardinality-'));
  const path = join(dir, 'ontology.yaml');
  try {
    writeFileSync(path, original);
    const baseline = generate(path);
    writeFileSync(path, mutated);
    const changed = generate(path);
    const sensitivity = {
      json_schema: changed.jsonSchema !== baseline.jsonSchema,
      typescript: changed.typescript !== baseline.typescript,
      shacl: !shaclEquivalent(changed.shacl, baseline.shacl),
    };

    assert.equal(sensitivity.json_schema, true, 'JSON Schema lost minimum cardinality');
    assert.equal(sensitivity.shacl, true, 'SHACL lost minimum cardinality');
    console.log('cardinality projection sensitivity', JSON.stringify(sensitivity));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
