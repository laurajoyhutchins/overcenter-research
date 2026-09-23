import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { FileEvidenceStore } from '../src/evidence/file-store.ts';
import { evidenceRef, validateEvidenceRef } from '../src/evidence/reference.ts';

test('evidence references bind exact bytes and reject malformed coordinates',()=>{
  const bytes=Buffer.from('overcenter evidence');
  const ref=evidenceRef(bytes);
  assert.equal(ref.algorithm,'sha256');
  assert.equal(ref.byte_length,bytes.byteLength);
  assert.match(ref.digest,/^[0-9a-f]{64}$/);
  assert.deepEqual(validateEvidenceRef(ref),ref);
  assert.throws(
    ()=>validateEvidenceRef({...ref,extra:true}),
    /INVALID_EVIDENCE_REF/,
  );
  assert.throws(
    ()=>validateEvidenceRef({...ref,digest:'bad'}),
    /INVALID_EVIDENCE_DIGEST/,
  );
});

test('file evidence store publishes, deduplicates, and verifies exact bytes',()=>{
  const root=mkdtempSync(join(tmpdir(),'file-evidence-store-'));
  try {
    const store=new FileEvidenceStore(root);
    const bytes=Buffer.from('durable evidence');
    const ref=store.put(bytes);
    assert.deepEqual(store.get(ref),bytes);
    assert.deepEqual(store.put(bytes),ref);
    assert.match(store.pathFor(ref),new RegExp(`/${ref.digest.slice(0,2)}/${ref.digest.slice(2)}$`));
    assert.throws(
      ()=>store.get({...ref,byte_length:ref.byte_length+1}),
      /EVIDENCE_LENGTH_MISMATCH/,
    );
    assert.throws(
      ()=>store.get(evidenceRef(Buffer.from('missing'))),
      /EVIDENCE_NOT_FOUND/,
    );
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('file evidence store rejects a corrupt object at the expected digest path',()=>{
  const root=mkdtempSync(join(tmpdir(),'file-evidence-corrupt-'));
  try {
    const store=new FileEvidenceStore(root);
    const bytes=Buffer.from('expected payload');
    const ref=evidenceRef(bytes);
    const path=store.pathFor(ref);
    mkdirSync(dirname(path),{recursive:true});
    writeFileSync(path,Buffer.from('corrupt'));
    assert.throws(()=>store.get(ref),/EVIDENCE_LENGTH_MISMATCH/);
    assert.throws(()=>store.put(bytes),/EVIDENCE_LENGTH_MISMATCH/);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('file evidence store sweeps only stale temporary objects',()=>{
  const root=mkdtempSync(join(tmpdir(),'file-evidence-sweep-'));
  try {
    const store=new FileEvidenceStore(root);
    const ref=store.put(Buffer.from('published'));
    const directory=dirname(store.pathFor(ref));
    const stale=join(directory,'.tmp-stale');
    const fresh=join(directory,'.tmp-fresh');
    writeFileSync(stale,'stale');
    writeFileSync(fresh,'fresh');
    const old=new Date(Date.now()-120_000);
    utimesSync(stale,old,old);

    assert.equal(store.sweepStaleTemps(60_000),1);
    assert.deepEqual(store.get(ref),Buffer.from('published'));
    assert.equal(store.sweepStaleTemps(1),1);
    assert.throws(()=>store.sweepStaleTemps(0),/INVALID_EVIDENCE_TEMP_AGE/);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
