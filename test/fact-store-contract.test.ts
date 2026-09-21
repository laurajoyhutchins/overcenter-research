import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { DurableFactStore } from '../src/fact-store.ts';
import type { FactCommit } from '../src/facts.ts';
import { GitFactStore } from '../src/git-store.ts';
import { SqliteFactStore } from '../src/sqlite-store.ts';

function normalized(history:FactCommit[]) {
  const ids=new Map(
    history.map((record,index)=>[record.commit,`commit-${index+1}`]),
  );
  return history.map(record=>({
    commit:ids.get(record.commit),
    parent:record.parent===null ? null : ids.get(record.parent),
    obligation:record.obligation??null,
    claim:record.claim??null,
    execution_authority:record.execution_authority??null,
    effect_reservation:record.effect_reservation??null,
    receipt:record.receipt??null,
  }));
}

function exercise(store:DurableFactStore) {
  const initial=store.append(null,'initialize');
  assert.ok(initial);

  const defined=store.append(
    initial,
    'define a',
    {'obligation.json':{schema:'test-obligation',id:'a'}},
  );
  assert.ok(defined);

  const stale=store.append(
    initial,
    'stale writer',
    {'claim.json':{schema:'should-not-land'}},
  );
  assert.equal(stale,null);

  const settled=store.append(
    defined,
    'settle a',
    {'receipt.json':{schema:'test-receipt',run_id:'run-a'}},
  );
  assert.ok(settled);
  assert.equal(store.head(),settled);

  const atDefinition=store.history(defined);
  assert.equal(atDefinition.length,2);
  assert.equal(atDefinition.at(-1)?.commit,defined);

  const current=store.history(settled);
  assert.equal(current.length,3);
  assert.equal(current.at(-1)?.commit,settled);
  assert.equal(
    current.some(record=>(record.claim as {schema?:string}|null)?.schema==='should-not-land'),
    false,
  );

  return {head:settled,history:current};
}

test('Git and SQLite satisfy the same durable fact store contract',()=>{
  const root=mkdtempSync(join(tmpdir(),'fact-store-contract-'));
  const gitRepo=join(root,'authority.git');
  const sqlitePath=join(root,'authority.sqlite');
  execFileSync('git',['init','--bare',gitRepo],{stdio:'ignore'});

  const git=new GitFactStore(gitRepo,{ref:'refs/overcenter/state'});
  const sqlite=new SqliteFactStore(sqlitePath);

  try {
    const gitResult=exercise(git);
    const sqliteResult=exercise(sqlite);

    assert.deepEqual(
      normalized(sqliteResult.history),
      normalized(gitResult.history),
    );

    sqlite.close();
    const reopened=new SqliteFactStore(sqlitePath);
    try {
      assert.equal(reopened.head(),sqliteResult.head);
      assert.deepEqual(
        normalized(reopened.history(sqliteResult.head)),
        normalized(sqliteResult.history),
      );
    } finally {
      reopened.close();
    }

    const reopenedGit=new GitFactStore(
      gitRepo,
      {ref:'refs/overcenter/state'},
    );
    assert.equal(reopenedGit.head(),gitResult.head);
    assert.deepEqual(
      normalized(reopenedGit.history(gitResult.head)),
      normalized(gitResult.history),
    );
  } finally {
    try {
      sqlite.close();
    } catch {}
    rmSync(root,{recursive:true,force:true});
  }
});


test('SQLite serializes simultaneous writers and admits exactly one same-head CAS winner',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-contention-'));
  const database=join(root,'authority.sqlite');
  const store=new SqliteFactStore(database);
  const initial=store.append(null,'initialize');
  assert.ok(initial);
  store.close();

  const fixture=fileURLToPath(
    new URL('./fixtures/sqlite-contender.ts',import.meta.url),
  );
  const contenders=Array.from({length:8},(_,index)=>
    new Promise<string|null>((resolve,reject)=>{
      const child=spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          fixture,
          database,
          initial,
          String(index),
        ],
        {stdio:['ignore','pipe','pipe']},
      );
      let stdout='';
      let stderr='';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data',chunk=>{stdout+=String(chunk);});
      child.stderr.on('data',chunk=>{stderr+=String(chunk);});
      child.once('error',reject);
      child.once('close',(code,signal)=>{
        if (code!==0) {
          reject(new Error(`contender failed (code=${code}, signal=${signal}): ${stderr}`));
          return;
        }
        const record=JSON.parse(stdout.trim()) as {commit:string|null};
        resolve(record.commit);
      });
    }),
  );

  try {
    const results=await Promise.all(contenders);
    assert.equal(results.filter(Boolean).length,1);

    const reopened=new SqliteFactStore(database);
    try {
      const head=reopened.head();
      assert.ok(head);
      const history=reopened.history(head);
      assert.equal(history.length,2);
      assert.equal(
        history.filter(record=>record.claim!=null).length,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
