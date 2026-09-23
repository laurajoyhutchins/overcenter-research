import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

type ObjectRecord={id:string;bytes:Buffer};

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

function traceBytes(target:number,variant:number):Buffer {
  const prefix=Buffer.from(`{"schema":"overcenter-execution-trace/v1","variant":${variant},"payload":"`);
  const suffix=Buffer.from('"}');
  const payload=Buffer.alloc(Math.max(0,target-prefix.length-suffix.length),120);
  return Buffer.concat([prefix,payload,suffix]);
}

function corpus():ObjectRecord[] {
  const records:ObjectRecord[]=[];
  for (let i=0;i<64;i+=1) {
    const bytes=traceBytes(256*1024,i);
    records.push({id:sha(bytes),bytes});
  }
  for (let i=0;i<16;i+=1) {
    const bytes=traceBytes(1024*1024,1000+i);
    records.push({id:sha(bytes),bytes});
  }
  return records;
}

function percentile(values:number[],p:number):number {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))]!;
}

function summary(values:number[]) {
  return {
    p50_us:Number(percentile(values,0.50).toFixed(3)),
    p95_us:Number(percentile(values,0.95).toFixed(3)),
  };
}

class FileCas {
  readonly dir:string;
  constructor(dir:string) {
    this.dir=dir;
    mkdirSync(dir,{recursive:true});
  }
  put(id:string,bytes:Buffer):boolean {
    const path=join(this.dir,id);
    try {
      const fd=openSync(path,'wx');
      try { writeFileSync(fd,bytes); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code==='EEXIST') return false;
      throw error;
    }
  }
  get(id:string):Buffer {
    const bytes=readFileSync(join(this.dir,id));
    if (sha(bytes)!==id) throw new Error('FILE_CAS_DIGEST_MISMATCH');
    return bytes;
  }
  delete(id:string):void {
    unlinkSync(join(this.dir,id));
  }
  ids():string[] { return readdirSync(this.dir); }
  physicalBytes():number {
    return this.ids().reduce((sum,id)=>sum+statSync(join(this.dir,id)).size,0);
  }
}

class SqliteCas {
  readonly path:string;
  db:DatabaseSync;
  constructor(path:string) {
    this.path=path;
    this.db=new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS evidence(
        digest TEXT PRIMARY KEY,
        bytes BLOB NOT NULL
      ) WITHOUT ROWID;
    `);
  }
  put(id:string,bytes:Buffer):boolean {
    const result=this.db.prepare(
      'INSERT OR IGNORE INTO evidence(digest,bytes) VALUES(?,?)'
    ).run(id,bytes);
    return result.changes===1;
  }
  get(id:string):Buffer {
    const row=this.db.prepare('SELECT bytes FROM evidence WHERE digest=?').get(id) as
      {bytes:Uint8Array}|undefined;
    if (!row) throw new Error('SQLITE_CAS_MISSING');
    const bytes=Buffer.from(row.bytes);
    if (sha(bytes)!==id) throw new Error('SQLITE_CAS_DIGEST_MISMATCH');
    return bytes;
  }
  delete(id:string):void {
    this.db.prepare('DELETE FROM evidence WHERE digest=?').run(id);
  }
  count():number {
    const row=this.db.prepare('SELECT COUNT(*) AS count FROM evidence').get() as
      {count:number|bigint};
    return Number(row.count);
  }
  checkpoint():void { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
  vacuum():void { this.db.exec('VACUUM'); this.checkpoint(); }
  close():void { this.db.close(); }
  reopen():void { this.close(); this.db=new DatabaseSync(this.path); }
  physicalBytes():number {
    let total=0;
    for (const suffix of ['', '-wal','-shm']) {
      const path=this.path+suffix;
      if (existsSync(path)) total+=statSync(path).size;
    }
    return total;
  }
}

test('filesystem and SQLite evidence CAS lifecycle',()=>{
  const records=corpus();
  assert.equal(new Set(records.map(r=>r.id)).size,80);
  const logicalBytes=records.reduce((sum,r)=>sum+r.bytes.length,0);
  const root=mkdtempSync(join(tmpdir(),'evidence-cas-backends-'));
  const file=new FileCas(join(root,'objects'));
  const sqlite=new SqliteCas(join(root,'evidence.sqlite'));

  const fileFirst:number[]=[];
  const fileDuplicate:number[]=[];
  const sqliteFirst:number[]=[];
  const sqliteDuplicate:number[]=[];

  try {
    for (const record of records) {
      let start=performance.now();
      assert.equal(file.put(record.id,record.bytes),true);
      fileFirst.push((performance.now()-start)*1000);

      start=performance.now();
      assert.equal(sqlite.put(record.id,record.bytes),true);
      sqliteFirst.push((performance.now()-start)*1000);
    }
    for (const record of records) {
      let start=performance.now();
      assert.equal(file.put(record.id,record.bytes),false);
      fileDuplicate.push((performance.now()-start)*1000);

      start=performance.now();
      assert.equal(sqlite.put(record.id,record.bytes),false);
      sqliteDuplicate.push((performance.now()-start)*1000);
    }

    assert.equal(file.ids().length,80);
    assert.equal(sqlite.count(),80);

    sqlite.checkpoint();
    const beforeGc={
      file_physical_bytes:file.physicalBytes(),
      sqlite_physical_bytes:sqlite.physicalBytes(),
    };

    const fileRead:number[]=[];
    const sqliteRead:number[]=[];
    for (const record of records) {
      let start=performance.now();
      assert.deepEqual(file.get(record.id),record.bytes);
      fileRead.push((performance.now()-start)*1000);

      start=performance.now();
      assert.deepEqual(sqlite.get(record.id),record.bytes);
      sqliteRead.push((performance.now()-start)*1000);
    }

    sqlite.reopen();
    for (const record of records) assert.deepEqual(sqlite.get(record.id),record.bytes);

    const deleted=records.filter((_,i)=>i%2===0);
    const retained=records.filter((_,i)=>i%2===1);
    const deleteStart=performance.now();
    for (const record of deleted) file.delete(record.id);
    const fileGcUs=(performance.now()-deleteStart)*1000;

    const sqliteDeleteStart=performance.now();
    sqlite.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of deleted) sqlite.delete(record.id);
      sqlite.db.exec('COMMIT');
    } catch (error) {
      sqlite.db.exec('ROLLBACK');
      throw error;
    }
    const sqliteDeleteUs=(performance.now()-sqliteDeleteStart)*1000;
    sqlite.checkpoint();

    assert.equal(file.ids().length,40);
    assert.equal(sqlite.count(),40);
    for (const record of retained) {
      assert.deepEqual(file.get(record.id),record.bytes);
      assert.deepEqual(sqlite.get(record.id),record.bytes);
    }

    const afterDelete={
      file_physical_bytes:file.physicalBytes(),
      sqlite_physical_bytes:sqlite.physicalBytes(),
    };
    const vacuumStart=performance.now();
    sqlite.vacuum();
    const sqliteVacuumUs=(performance.now()-vacuumStart)*1000;
    const afterVacuumSqliteBytes=sqlite.physicalBytes();

    sqlite.reopen();
    for (const record of retained) assert.deepEqual(sqlite.get(record.id),record.bytes);

    console.log('EVIDENCE_CAS_LOCAL_BACKEND_RESULT '+JSON.stringify({
      schema:'overcenter-evidence-cas-local-backend-result/v1',
      objects:80,
      logical_bytes:logicalBytes,
      filesystem:{
        first_put:summary(fileFirst),
        duplicate_put:summary(fileDuplicate),
        verified_read:summary(fileRead),
        physical_before_gc:beforeGc.file_physical_bytes,
        physical_after_gc:afterDelete.file_physical_bytes,
        gc_us:Number(fileGcUs.toFixed(3)),
      },
      sqlite:{
        first_put:summary(sqliteFirst),
        duplicate_put:summary(sqliteDuplicate),
        verified_read:summary(sqliteRead),
        physical_before_gc:beforeGc.sqlite_physical_bytes,
        physical_after_delete_checkpoint:afterDelete.sqlite_physical_bytes,
        physical_after_vacuum:afterVacuumSqliteBytes,
        delete_us:Number(sqliteDeleteUs.toFixed(3)),
        vacuum_us:Number(sqliteVacuumUs.toFixed(3)),
      },
      retained_objects:40,
      deleted_objects:40,
      identity_mismatches:0,
    }));
  } finally {
    try { sqlite.close(); } catch {}
    rmSync(root,{recursive:true,force:true});
  }
});
