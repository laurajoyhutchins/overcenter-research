import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  analyzeAdapterProtocol,
  boundedAmbiguousObservationSequences,
  releaseDecision,
  type AdapterProtocol,
} from '../scripts/adapter-diagnosability.ts';
import { ADAPTER_DIAGNOSABILITY_CASES } from '../scripts/adapter-diagnosability-cases.ts';

test('maintained adapter diagnosability cases match their independently established boundary', () => {
  for (const { protocol, expected } of ADAPTER_DIAGNOSABILITY_CASES) {
    const analysis = analyzeAdapterProtocol(protocol);
    assert.deepEqual(
      {
        diagnosable: analysis.diagnosable,
        safeDiagnosable: analysis.safeDiagnosable,
        decision: releaseDecision(analysis),
      },
      expected,
      protocol.id,
    );
    assert.equal(
      boundedAmbiguousObservationSequences(protocol, 12) > 0,
      !analysis.diagnosable,
      `${protocol.id}: oracle disagreement`,
    );
  }
});

test('broadening NOT_DISPATCHED to a possibly-mutated world blocks release', () => {
  const hostile: AdapterProtocol = {
    id: 'hostile-broad-not-dispatched',
    initial: 's',
    states: [
      { id: 's', mutation: 'not-occurred' },
      { id: 'c', mutation: 'occurred' },
      { id: 'n', mutation: 'not-occurred' },
      { id: 'ma', mutation: 'occurred' },
      { id: 'na', mutation: 'not-occurred' },
      { id: 'mr', mutation: 'occurred' },
      { id: 'nr', mutation: 'not-occurred' },
    ],
    transitions: [
      { from: 's', to: 'c', event: 'remote-commit' },
      { from: 's', to: 'n', event: 'remote-no-commit' },
      {
        from: 'c',
        to: 'ma',
        event: 'transport-failure',
        observation: 'GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED',
      },
      {
        from: 'n',
        to: 'na',
        event: 'transport-failure',
        observation: 'GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED',
      },
      {
        from: 'ma',
        to: 'mr',
        event: 'release-reservation',
        observation: 'RELEASED',
        consequential: 'release-authority',
      },
      {
        from: 'na',
        to: 'nr',
        event: 'release-reservation',
        observation: 'RELEASED',
        consequential: 'release-authority',
      },
      { from: 'mr', to: 'mr', event: 'readback', observation: 'NO_AUTHORITATIVE_EVIDENCE' },
      { from: 'nr', to: 'nr', event: 'readback', observation: 'NO_AUTHORITATIVE_EVIDENCE' },
    ],
  };

  const analysis = analyzeAdapterProtocol(hostile);
  assert.equal(analysis.diagnosable, false);
  assert.equal(analysis.safeDiagnosable, false);
  assert.equal(releaseDecision(analysis), 'ambiguous-do-not-release');
  assert.equal(analysis.unsafeWitness?.action, 'release-authority');
  assert.deepEqual(
    analysis.unsafeWitnesses.map((witness) => witness.action),
    ['release-authority'],
  );
  assert.ok(analysis.nonDiagnosableWitness?.length);
  assert.ok(boundedAmbiguousObservationSequences(hostile, 12) > 0);
});

test('a trusted distinguishing observation can make the same release point diagnosable', () => {
  const protocol: AdapterProtocol = {
    id: 'distinguished-reset',
    initial: 's',
    states: [
      { id: 's', mutation: 'not-occurred' },
      { id: 'c', mutation: 'occurred' },
      { id: 'n', mutation: 'not-occurred' },
      { id: 'mc', mutation: 'occurred' },
      { id: 'nc', mutation: 'not-occurred' },
    ],
    transitions: [
      { from: 's', to: 'c', event: 'remote-commit' },
      { from: 's', to: 'n', event: 'remote-no-commit' },
      { from: 'c', to: 'mc', event: 'observe', observation: 'COMMIT_CONFIRMED' },
      { from: 'n', to: 'nc', event: 'observe', observation: 'ABSENCE_CONFIRMED' },
      {
        from: 'mc',
        to: 'mc',
        event: 'settle',
        observation: 'DONE',
        consequential: 'settle-done',
      },
      {
        from: 'nc',
        to: 'nc',
        event: 'release',
        observation: 'RELEASED',
        consequential: 'release-authority',
      },
    ],
  };

  const analysis = analyzeAdapterProtocol(protocol);
  assert.equal(analysis.diagnosable, true);
  assert.equal(analysis.safeDiagnosable, true);
  assert.equal(analysis.unsafeWitness, undefined);
  assert.deepEqual(analysis.unsafeWitnesses, []);
  assert.equal(boundedAmbiguousObservationSequences(protocol, 12), 0);
});

test('all distinct consequential actions reachable while ambiguous get witnesses', () => {
  const protocol: AdapterProtocol = {
    id: 'multiple-unsafe-actions',
    initial: 's',
    states: [
      { id: 's', mutation: 'not-occurred' },
      { id: 'c', mutation: 'occurred' },
      { id: 'n', mutation: 'not-occurred' },
    ],
    transitions: [
      { from: 's', to: 'c', event: 'remote-commit' },
      { from: 's', to: 'n', event: 'remote-no-commit' },
      {
        from: 'c',
        to: 'c',
        event: 'settle',
        observation: 'DONE',
        consequential: 'settle-done',
      },
      {
        from: 'n',
        to: 'n',
        event: 'release',
        observation: 'RELEASED',
        consequential: 'release-authority',
      },
    ],
  };

  const analysis = analyzeAdapterProtocol(protocol);
  assert.equal(analysis.diagnosable, true);
  assert.equal(analysis.safeDiagnosable, false);
  assert.deepEqual(
    analysis.unsafeWitnesses.map((witness) => witness.action),
    ['release-authority', 'settle-done'],
  );
  assert.equal(analysis.unsafeWitness?.action, 'release-authority');
  assert.ok(
    analysis.unsafeWitnesses.every(
      (witness) => witness.pair.length === 2 && Array.isArray(witness.trace),
    ),
  );
});

test('malformed protocol descriptions fail before analysis', () => {
  const malformed: AdapterProtocol = {
    id: 'malformed',
    initial: 's',
    states: [{ id: 's', mutation: 'not-occurred' }],
    transitions: [{ from: 's', to: 'missing', event: 'bad-edge' }],
  };

  assert.throws(
    () => analyzeAdapterProtocol(malformed),
    /ADAPTER_PROTOCOL_TRANSITION_TO_UNKNOWN:missing/,
  );
});

function TypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return TypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

test('diagnosability tooling has no production runtime import', () => {
  for (const path of TypeScriptFiles('src')) {
    assert.equal(
      readFileSync(path, 'utf8').includes('adapter-diagnosability'),
      false,
      `${path}: production source imports development-only diagnosability tooling`,
    );
  }
});
