import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
