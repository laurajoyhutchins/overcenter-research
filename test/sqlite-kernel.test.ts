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


test('SQLite graph patch admits multiple nodes in one authority transition',()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-graph-patch-'));
  const database=join(root,'overcenter.sqlite');
  const kernel=new OvercenterKernel(database);
  try {
    const initial=kernel.initialize();
    const commit=kernel.applyGraphPatch({
      upsert:[
        {
          id:'second',
          dependencies:[{kind:'control',upstream:'first'}],
          postcondition:pc(join(root,'second'),'B'),
        },
        {
          id:'first',
          postcondition:pc(join(root,'first'),'A'),
        },
      ],
    },initial);

    assert.equal(kernel.head(),commit);
    assert.deepEqual(
      kernel.inspect().map(work=>[work.id,work.status]),
      [['first','READY'],['second','BLOCKED']],
    );

    const db=new DatabaseSync(database);
    try {
      const rows=db.prepare(
        'SELECT sequence, files_json FROM fact_commits ORDER BY sequence',
      ).all() as Array<{sequence:number;files_json:string}>;
      assert.equal(rows.length,2);
      const files=JSON.parse(rows[1].files_json) as Record<string,unknown>;
      assert.equal('obligation.json' in files,false);
      assert.equal('obligations.json' in files,false);
      const patch=files['graph-patch.json'] as {
        definitions:unknown[];
        bindings:unknown[];
        retire:unknown[];
      };
      assert.equal(Array.isArray(patch.definitions),true);
      assert.equal(patch.definitions.length,2);
      assert.equal(patch.bindings.length,2);
      assert.deepEqual(patch.retire,[]);
    } finally {
      db.close();
    }
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('SQLite graph reconciliation derives add replace and no-op without extra writes',()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-graph-reconcile-'));
  const database=join(root,'overcenter.sqlite');
  const kernel=new OvercenterKernel(database);
  try {
    const initial=kernel.initialize();
    const first=kernel.reconcileGraph([
      {id:'root',postcondition:pc(join(root,'root'),'R')},
      {
        id:'leaf',
        dependencies:[{kind:'control',upstream:'root'}],
        packet:{generation:1},
        postcondition:pc(join(root,'leaf'),'L'),
      },
    ],initial);
    assert.deepEqual(first.added,['leaf','root']);
    assert.deepEqual(first.rebound,[]);
    assert.deepEqual(first.unchanged,[]);

    const unchanged=kernel.reconcileGraph([
      {
        id:'leaf',
        dependencies:[{kind:'control',upstream:'root'}],
        packet:{generation:1},
        postcondition:pc(join(root,'leaf'),'L'),
      },
      {id:'root',postcondition:pc(join(root,'root'),'R')},
    ],first.revision);
    assert.equal(unchanged.revision,first.revision);
    assert.deepEqual(unchanged.added,[]);
    assert.deepEqual(unchanged.rebound,[]);
    assert.deepEqual(unchanged.unchanged,['leaf','root']);

    const changed=kernel.reconcileGraph([
      {
        id:'leaf',
        dependencies:[{kind:'control',upstream:'root'}],
        packet:{generation:2},
        postcondition:pc(join(root,'leaf'),'L'),
      },
      {id:'extra',postcondition:pc(join(root,'extra'),'E')},
    ],unchanged.revision);
    assert.deepEqual(changed.added,['extra']);
    assert.deepEqual(changed.rebound,['leaf']);
    assert.deepEqual(changed.unchanged,[]);

    const db=new DatabaseSync(database);
    try {
      const row=db.prepare('SELECT COUNT(*) AS count FROM fact_commits').get() as {count:number};
      assert.equal(Number(row.count),3);
    } finally {
      db.close();
    }
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('no-op graph reconciliation remains read-only while work is in flight',()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-graph-reconcile-busy-noop-'));
  const database=join(root,'overcenter.sqlite');
  const kernel=new OvercenterKernel(database);
  try {
    const initial=kernel.initialize();
    const defined=kernel.reconcileGraph([
      {id:'a',packet:{value:1},postcondition:pc(join(root,'a'),'A')},
    ],initial);
    const run=kernel.claim('a',defined.revision);
    const head=kernel.head();
    assert.ok(head);

    const result=kernel.reconcileGraph([
      {id:'a',packet:{value:1},postcondition:pc(join(root,'a'),'A')},
    ],head);
    assert.equal(result.revision,head);
    assert.deepEqual(result.added,[]);
    assert.deepEqual(result.rebound,[]);
    assert.deepEqual(result.unchanged,['a']);

    assert.throws(
      ()=>kernel.reconcileGraph([
        {id:'a',packet:{value:2},postcondition:pc(join(root,'a'),'A')},
      ],head),
      /PROJECT_BUSY/,
    );
    assert.equal(kernel.head(),head);
    kernel.recoverInterrupted(run);
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('invalid SQLite graph patch leaves authority unchanged',()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-invalid-graph-patch-'));
  const database=join(root,'overcenter.sqlite');
  const kernel=new OvercenterKernel(database);
  try {
    const initial=kernel.initialize();
    assert.throws(
      ()=>kernel.applyGraphPatch({
        upsert:[{
          id:'dangling',
          dependencies:[{kind:'control',upstream:'missing'}],
          postcondition:pc(join(root,'dangling'),'A'),
        }],
      },initial),
      /UNKNOWN_DEPENDENCY:dangling:missing/,
    );
    assert.equal(kernel.head(),initial);

    const db=new DatabaseSync(database);
    try {
      const row=db.prepare('SELECT COUNT(*) AS count FROM fact_commits').get() as {count:number};
      assert.equal(Number(row.count),1);
    } finally {
      db.close();
    }
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('graph patch rebinding is exact-revision fenced',()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-graph-patch-replace-'));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'));
  try {
    const initial=kernel.initialize();
    const defined=kernel.applyGraphPatch({
      upsert:[{id:'a',postcondition:pc(join(root,'a'),'A')}],
    },initial);
    const replaced=kernel.applyGraphPatch({
      upsert:[{id:'a',packet:{generation:2},postcondition:pc(join(root,'a'),'B')}],
    },defined);
    assert.equal(kernel.head(),replaced);
    assert.throws(
      ()=>kernel.applyGraphPatch({
        upsert:[{id:'a',postcondition:pc(join(root,'a'),'C')}],
      },defined),
      /STALE_REVISION/,
    );
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('retirement validates the complete resulting graph atomically',()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-graph-retire-'));
  const kernel=new OvercenterKernel(join(root,'overcenter.sqlite'));
  try {
    const initial=kernel.initialize();
    const built=kernel.applyGraphPatch({
      upsert:[
        {id:'first',postcondition:pc(join(root,'first'),'A')},
        {
          id:'second',
          dependencies:[{kind:'control',upstream:'first'}],
          postcondition:pc(join(root,'second'),'B'),
        },
      ],
    },initial);

    assert.throws(
      ()=>kernel.applyGraphPatch({retire:['first']},built),
      /UNKNOWN_DEPENDENCY:second:first/,
    );
    assert.equal(kernel.head(),built);

    const retired=kernel.applyGraphPatch({
      upsert:[{
        id:'second',
        postcondition:pc(join(root,'second'),'B'),
      }],
      retire:['first'],
    },built);
    assert.equal(kernel.head(),retired);
    assert.deepEqual(
      kernel.inspect().map(work=>[work.id,work.status]),
      [['second','READY']],
    );
  } finally {
    kernel.close();
    rmSync(root,{recursive:true,force:true});
  }
});

test('retired node can rebind the same immutable definition and reuse evidence',()=>{
  const root=mkdtempSync(join(tmpdir(),'sqlite-graph-reintroduce-'));
  const database=join(root,'overcenter.sqlite');
  const path=join(root,'a');
  const kernel=new OvercenterKernel(database);
  try {
    kernel.initialize();
    kernel.define({
      id:'a',
      packet:{kind:'same-definition'},
      postcondition:pc(path,'A'),
    });
    const run=kernel.claim('a',kernel.deriveReadyWork()!.revision);
    writeFileSync(path,'A');
    assert.equal(kernel.resolve(run).disposition,'DONE');

    kernel.applyGraphPatch({retire:['a']},kernel.head()!);
    assert.deepEqual(kernel.inspect(),[]);

    kernel.applyGraphPatch({
      upsert:[{
        id:'a',
        packet:{kind:'same-definition'},
        postcondition:pc(path,'A'),
      }],
    },kernel.head()!);
    assert.equal(kernel.inspect()[0].status,'DONE');
    assert.equal(kernel.inspect()[0].run_id,run.id);

    const db=new DatabaseSync(database);
    try {
      const rows=db.prepare(
        'SELECT files_json FROM fact_commits WHERE files_json LIKE ? ORDER BY sequence',
      ).all('%"graph-patch.json"%') as Array<{files_json:string}>;
      assert.equal(rows.length,3);
      const reintroduced=JSON.parse(rows[2].files_json)['graph-patch.json'] as {
        definitions:unknown[];
        bindings:unknown[];
        retire:unknown[];
      };
      assert.deepEqual(reintroduced.definitions,[]);
      assert.equal(reintroduced.bindings.length,1);
      assert.deepEqual(reintroduced.retire,[]);
    } finally {
      db.close();
    }
  } finally {
    kernel.close();
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
        'graph-patch.json':{
          schema:'tampered',
          definitions:[],
          bindings:[],
          retire:[],
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
