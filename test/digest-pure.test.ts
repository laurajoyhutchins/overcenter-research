import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDigest, sha256 } from '../src/digest.ts';

test('canonical digest is stable across object key order', () => {
  const left = { z: 2, a: { y: 3, x: [2, { b: 1, a: 0 }] } };
  const right = { a: { x: [2, { a: 0, b: 1 }], y: 3 }, z: 2 };
  assert.equal(canonicalDigest(left), canonicalDigest(right));
  assert.equal(
    canonicalDigest(left),
    '60c77fccc512e8f6bcad2e45a9b599e12bbc72bd678a8e8f5fab9af532ceae3c',
  );
});

test('raw SHA-256 preserves the existing content identity', () => {
  assert.equal(sha256('A'), '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd');
});
