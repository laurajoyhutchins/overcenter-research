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

test('generated projections are repeatable from one canonical model', () => {
  const first = generate(SCHEMA);
  const second = generate(SCHEMA);
  assert.deepEqual(second, first);

  assert.match(first.jsonSchema, /Settlement/);
  assert.match(first.typescript, /Settlement/);
  assert.match(first.shacl, /Settlement/);
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
    assert.notEqual(changed.shacl, baseline.shacl);
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
      shacl: changed.shacl !== baseline.shacl,
    };

    assert.equal(sensitivity.json_schema, true, 'JSON Schema lost minimum cardinality');
    assert.equal(sensitivity.shacl, true, 'SHACL lost minimum cardinality');
    console.log('cardinality projection sensitivity', JSON.stringify(sensitivity));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
