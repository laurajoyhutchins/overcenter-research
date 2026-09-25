import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bootstrapMedianInterval,
  median,
  pairedRatios,
  zeroFailureUpperBound,
} from '../scripts/experiment-statistics.ts';

test('median handles odd and even sample counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('paired ratios preserve within-round comparisons', () => {
  assert.deepEqual(pairedRatios([2, 4, 8], [4, 8, 16]), [2, 2, 2]);
});

test('bootstrap median interval is exact for a degenerate sample', () => {
  assert.deepEqual(bootstrapMedianInterval([2, 2, 2, 2], { resamples: 1000 }), {
    lower: 2,
    upper: 2,
    confidence: 0.95,
    resamples: 1000,
  });
});

test('zero-failure bound reports residual sampled risk rather than zero', () => {
  assert.ok(Math.abs(zeroFailureUpperBound(7) - 0.3481636551311609) < 1e-12);
  assert.ok(Math.abs(zeroFailureUpperBound(200) - 0.014867039231272082) < 1e-12);
});

test('invalid statistical inputs fail closed', () => {
  assert.throws(() => median([]), /MEDIAN:EMPTY/);
  assert.throws(() => pairedRatios([1], [1, 2]), /INVALID_LENGTH/);
  assert.throws(() => zeroFailureUpperBound(0), /INVALID_TRIALS/);
});
