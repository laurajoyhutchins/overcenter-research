#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  analyzeEffectProtocol,
  boundedAmbiguousObservationSequences,
  releaseDecision,
} from './effect-protocol-diagnosability.ts';
import { EFFECT_PROTOCOL_DIAGNOSABILITY_CASES } from './effect-protocol-diagnosability-cases.ts';

const reports = EFFECT_PROTOCOL_DIAGNOSABILITY_CASES.map(({ protocol, expected }) => {
  const analysis = analyzeEffectProtocol(protocol);
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
    assert.ok(
      analysis.unsafeWitnesses.some((witness) => witness.action === 'release-authority'),
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
    unsafeActions: analysis.unsafeWitnesses.map((witness) => witness.action),
  };
});

console.log(
  JSON.stringify(
    {
      check: 'effect-protocol-diagnosability',
      authority: 'development-tooling-only',
      reports,
    },
    null,
    2,
  ),
);
