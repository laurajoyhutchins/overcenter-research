import assert from 'node:assert/strict';
import test from 'node:test';

import { combineMutationShards } from './combine-mutation-shards.ts';

test('combines isolated probe reports without collapsing mutant identities', () => {
  const shard = (probeId, file, mutantId, line) => ({
    probeId,
    report: {
      schemaVersion: '1',
      files: {
        [file]: {
          source: 'source',
          mutants: [
            {
              id: mutantId,
              status: 'Killed',
              location: { start: { line }, end: { line } },
            },
          ],
        },
      },
    },
    ranges: {
      schema: 'overcenter-criticality-resolved-mutation-probes/v1',
      typescript: '5.8.3',
      probes: [{ id: probeId, ranges: [{ file, start: line, end: line }] }],
    },
  });

  const combined = combineMutationShards([
    shard('effect-reservation', 'src/authority/engine.ts', '0', 10),
    shard('settlement', 'src/authority/engine.ts', '0', 20),
  ]);

  assert.deepEqual(
    combined.report.files['src/authority/engine.ts'].mutants.map((mutant) => mutant.id),
    ['effect-reservation:0', 'settlement:0'],
  );
  assert.deepEqual(
    combined.ranges.probes.map((probe) => probe.id),
    ['effect-reservation', 'settlement'],
  );
});

test('rejects mismatched shard identity', () => {
  assert.throws(
    () =>
      combineMutationShards([
        {
          probeId: 'expected',
          report: { files: {} },
          ranges: {
            schema: 'overcenter-criticality-resolved-mutation-probes/v1',
            typescript: '5.8.3',
            probes: [{ id: 'other', ranges: [] }],
          },
        },
      ]),
    /range identity mismatch/,
  );
});
