import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  OvercenterKernel,
  runCoreLoop,
} from '../src/kernel.ts';

const pc=(path:string,content:string)=>({
  verifier:'file-content-equals/v1' as const,
  path,
  content,
});

test('SQLite production kernel reconstructs project truth after close and reopen',async()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-kernel-'));
  const database=join(root,'overcenter.sqlite');
  const firstPath=join(root,'first.txt');
  const secondPath=join(root,'second.txt');
  const kernel=new OvercenterKernel(database);

  try {
    const initial=kernel.initialize();
    assert.equal(kernel.head(),initial);

    kernel.define({
      id:'first',
      packet:{path:firstPath,content:'A'},
      postcondition:pc(firstPath,'A'),
    });
    kernel.define({
      id:'second',
      dependencies:[{kind:'control',upstream:'first'}],
      packet:{path:secondPath,content:'B'},
      postcondition:pc(secondPath,'B'),
    });

    const result=await runCoreLoop(kernel,{
      effect:async packet=>{
        writeFileSync(
          String(packet.path),
          String(packet.content),
        );
        return {kind:'ok'};
      },
    });
    assert.equal(result.state,'IDLE');

    const before=kernel.inspect();
    assert.deepEqual(
      before.map(work=>[work.id,work.status]),
      [['first','DONE'],['second','DONE']],
    );
    const beforeExplanations=before.map(work=>kernel.explain(work.id));
    const beforeReceipts=kernel.receipts();
    const head=kernel.head();
    assert.ok(head);

    kernel.close();

    const fresh=new OvercenterKernel(database);
    try {
      assert.equal(fresh.initialize(),head);
      assert.deepEqual(fresh.inspect(),before);
      assert.deepEqual(
        fresh.inspect().map(work=>fresh.explain(work.id)),
        beforeExplanations,
      );
      assert.deepEqual(fresh.receipts(),beforeReceipts);
    } finally {
      fresh.close();
    }

    const db=new DatabaseSync(database);
    try {
      const tables=db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type='table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all().map(row=>String(row.name));
      assert.deepEqual(tables,['authority','fact_commits']);

      const commitColumns=db.prepare(
        'PRAGMA table_info(fact_commits)',
      ).all().map(row=>String(row.name));
      assert.deepEqual(
        commitColumns,
        ['sequence','commit_id','parent_id','message','files_json'],
      );

      const receiptRows=db.prepare(`
        SELECT files_json
        FROM fact_commits
        WHERE files_json LIKE '%"receipt.json"%'
      `).all() as Array<{files_json:string}>;
      assert.ok(receiptRows.length>=2);
      for (const row of receiptRows) {
        const files=JSON.parse(row.files_json) as Record<string,unknown>;
        const receipt=files['receipt.json'] as Record<string,unknown>;
        assert.equal('disposition' in receipt,false);
        assert.equal('verified' in receipt,false);
      }
    } finally {
      db.close();
    }
  } finally {
    try {
      kernel.close();
    } catch {}
    rmSync(root,{recursive:true,force:true});
  }
});


test('SQLite kernel rejects every inexact execution permit identity',()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-execution-authority-'));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'));
  try {
    kernel.initialize();
    kernel.define({id:'a',postcondition:pc(join(root,'a'),'A')});
    const run=kernel.claim('a',kernel.deriveReadyWork()!.revision);
    for (const hostile of [
      {...run,obligation_id:'other'},
      {...run,claimed_revision:'stale'},
      {...run,claim_commit:'stale'},
      {...run,obligation_key:'stale'},
      {...run,execution_generation:run.execution_generation+1},
      {...run,execution_authority_commit:'stale'},
      {...run,execution_capability_sha256:'0'.repeat(64)},
      {...run,execution_capability:'wrong'},
    ]) {
      assert.throws(()=>kernel.beginEffect(hostile),/STALE_EXECUTION_GENERATION/);
      assert.throws(()=>kernel.resolve(hostile),/STALE_EXECUTION_GENERATION/);
    }
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('SQLite kernel rejects a claim fenced to a stale authority revision',()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-stale-revision-'));
  const database=join(root,'overcenter.sqlite');
  const first=new OvercenterKernel(database);
  const second=new OvercenterKernel(database);

  try {
    first.initialize();
    first.define({
      id:'a',
      postcondition:pc(join(root,'a'),'A'),
    });
    const stale=first.deriveReadyWork();
    assert.ok(stale);

    second.define({
      id:'b',
      postcondition:pc(join(root,'b'),'B'),
    });

    assert.throws(
      ()=>first.claim('a',stale.revision),
      /STALE_REVISION/,
    );
  } finally {
    first.close();
    second.close();
    rmSync(root,{recursive:true,force:true});
  }
});


test('SQLite replay fails closed when durable fact bytes no longer match their commit id',()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-corruption-'));
  const database=join(root,'overcenter.sqlite');
  const kernel=new OvercenterKernel(database);

  try {
    kernel.initialize();
    kernel.define({
      id:'a',
      postcondition:pc(join(root,'a'),'A'),
    });
    kernel.close();

    const db=new DatabaseSync(database);
    try {
      db.prepare(`
        UPDATE fact_commits
        SET files_json = ?
        WHERE sequence = 2
      `).run(JSON.stringify({
        'obligation.json':{
          schema:'tampered',
          obligation:{id:'a'},
        },
      }));
    } finally {
      db.close();
    }

    const corrupted=new OvercenterKernel(database);
    try {
      assert.throws(
        ()=>corrupted.inspect(),
        /FACT_COMMIT_DIGEST_MISMATCH/,
      );
    } finally {
      corrupted.close();
    }
  } finally {
    try {
      kernel.close();
    } catch {}
    rmSync(root,{recursive:true,force:true});
  }
});
