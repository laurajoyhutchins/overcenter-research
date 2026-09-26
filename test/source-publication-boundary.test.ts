import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('source candidate publication does not bypass reserved effects', () => {
  const source = readFileSync(
    new URL('../src/source/source-integration.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('function publishSourceCandidate(');
  const end = source.indexOf('\nexport function brokerSourceProposal(', start);
  assert.notEqual(start, -1, 'publishSourceCandidate must remain mechanically inspectable');
  assert.notEqual(end, -1, 'brokerSourceProposal boundary must remain mechanically inspectable');

  const publication = source.slice(start, end);
  assert.doesNotMatch(
    publication,
    /gitStatus\([^\n]*\['push'|git[^\n]*\bpush\b/,
    'candidate review-ref publication must cross an admitted reserved-effect boundary',
  );
});
