import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalDigest,
  canonicalJson,
  canonicalStringCompare,
  sha256,
} from '../src/digest.ts';

test('canonical digest is stable across object key order',()=>{
  const left={z:2,a:{y:3,x:[2,{b:1,a:0}]}};
  const right={a:{x:[2,{a:0,b:1}],y:3},z:2};
  assert.equal(canonicalDigest(left),canonicalDigest(right));
  assert.equal(
    canonicalDigest(left),
    '60c77fccc512e8f6bcad2e45a9b599e12bbc72bd678a8e8f5fab9af532ceae3c',
  );
});

test('canonical JSON uses Unicode-scalar key order, not locale collation or JS integer-key enumeration',()=>{
  assert.equal(canonicalStringCompare('z','ä'),-1);
  assert.equal(canonicalStringCompare('雪','😀'),-1);
  assert.equal(
    canonicalJson({
      '2':'two',
      '10':'ten',
      z:1,
      'ä':2,
      '😀':3,
      '雪':4,
    }),
    '{"10":"ten","2":"two","z":1,"ä":2,"雪":4,"😀":3}',
  );
  assert.equal(
    canonicalJson({nested:{'2':2,'10':10,b:true,a:null},array:[{z:2,a:1},3]}),
    '{"array":[{"a":1,"z":2},3],"nested":{"10":10,"2":2,"a":null,"b":true}}',
  );
});

test('raw SHA-256 preserves the existing content identity',()=>{
  assert.equal(
    sha256('A'),
    '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
  );
});
