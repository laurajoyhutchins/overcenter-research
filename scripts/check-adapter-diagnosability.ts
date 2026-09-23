#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  analyzeAdapterProtocol,
  boundedAmbiguousObservationSequences,
  releaseDecision,
} from './adapter-diagnosability.ts';
import { ADAPTER_DIAGNOSABILITY_CASES } from './adapter-diagnosability-cases.ts';

const reports = ADAPTER_DIAGNOSABILITY_CASES.map(({ protocol, expected }) => {
  const analysis = analyzeAdapterProtocol(protocol);
  const depth12AmbiguousSequences = boundedAmbiguousObservationSequences(protocol, 12);
  const decision = releaseDecision(analysis);

  assert.deepEqual(
    {
      diagnosable: analysis.diagnosable,
      safeDiagnosable: analysis.safeDiagnosable,
      decision,
    },
    expected,
    `${protocol.id}: diagnosability contract changed`,
  );
  assert.equal(
    depth12AmbiguousSequences > 0,
    !analysis.diagnosable,
    `${protocol.id}: independent depth-12 oracle disagrees`,
  );
  if (!analysis.diagnosable) {
    assert.ok(analysis.nonDiagnosableWitness?.length, `${protocol.id}: missing ambiguity witness`);
  }
  if (!analysis.safeDiagnosable) {
    assert.equal(
      analysis.unsafeWitness?.action,
      'release-authority',
      `${protocol.id}: unsafe release witness missing`,
    );
  }

  return {
    protocol: protocol.id,
    diagnosable: analysis.diagnosable,
    safeDiagnosable: analysis.safeDiagnosable,
    ambiguousPairs: analysis.ambiguousPairs,
    maxAmbiguousObservableDelay: analysis.maxAmbiguousObservableDelay,
    depth12AmbiguousSequences,
    decision,
    unsafeAction: analysis.unsafeWitness?.action ?? null,
  };
});

console.log(
  JSON.stringify(
    {
      check: 'adapter-diagnosability',
      authority: 'development-tooling-only',
      reports,
    },
    null,
    2,
  ),
);
