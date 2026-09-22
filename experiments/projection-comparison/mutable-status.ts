import { DatabaseSync } from 'node:sqlite';
import type {
  ProjectStatus,
  StatusMap,
} from './model.ts';

// Deliberately shaped after experiments/sqlite-baseline/kernel.ts, but with
// BLOCKED made explicit so it can represent the current public vocabulary.
// Correctness depends on lifecycle rows being mutated when semantic meaning
// changes.
export class MutableStatusMachine {
  readonly db=new DatabaseSync(':memory:');
  #writes=0;

  constructor(
    obligations:string[],
    dependencies:Array<{downstream:string;upstream:string}>,
  ) {
    this.db.exec(`
      CREATE TABLE obligations (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE dependencies (
        downstream TEXT NOT NULL,
        upstream TEXT NOT NULL
      );
      CREATE TABLE lifecycle (
        obligation TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);

    const insertObligation=this.db.prepare(
      'INSERT INTO obligations(id) VALUES (?)',
    );
    const insertDependency=this.db.prepare(
      'INSERT INTO dependencies(downstream,upstream) VALUES (?,?)',
    );
    const insertLifecycle=this.db.prepare(
      'INSERT INTO lifecycle(obligation,status) VALUES (?,?)',
    );

    for (const id of obligations) insertObligation.run(id);
    for (const edge of dependencies) {
      insertDependency.run(edge.downstream,edge.upstream);
    }
    for (const id of obligations) {
      const hasDependency=dependencies.some(edge=>edge.downstream===id);
      insertLifecycle.run(id,hasDependency?'BLOCKED':'READY');
    }
  }

  close():void {
    this.db.close();
  }

  get statusWrites():number {
    return this.#writes;
  }

  snapshot():StatusMap {
    const rows=this.db.prepare(`
      SELECT o.id, l.status
      FROM obligations o
      LEFT JOIN lifecycle l ON l.obligation=o.id
      ORDER BY o.id
    `).all() as Array<{id:string;status:ProjectStatus|null}>;
    if (rows.some(row=>row.status===null)) {
      throw new Error('MATERIALIZED_LIFECYCLE_MISSING');
    }
    return new Map(rows.map(row=>[row.id,row.status!]));
  }

  claim(id:string):void {
    if (this.#status(id)!=='READY') throw new Error('NOT_READY');
    this.#write(id,'EXECUTING');
  }

  settle(id:string,disposition:Exclude<ProjectStatus,'BLOCKED'|'EXECUTING'>):void {
    this.#write(id,disposition);
    this.#refreshDirectDependents(id);
  }

  // A semantic-key change or withdrawn realization admissibility has no
  // representation in stored lifecycle itself. The caller must remember to
  // perform this repair mutation.
  invalidateMeaning(id:string):void {
    this.#write(id,'READY');
    this.#blockDependentsTransitively(id);
  }

  eraseLifecycle():void {
    this.db.exec('DELETE FROM lifecycle');
  }

  #status(id:string):ProjectStatus {
    const row=this.db.prepare(
      'SELECT status FROM lifecycle WHERE obligation=?',
    ).get(id) as {status:ProjectStatus}|undefined;
    if (!row) throw new Error('MATERIALIZED_LIFECYCLE_MISSING');
    return row.status;
  }

  #write(id:string,status:ProjectStatus):void {
    const current=this.#status(id);
    if (current===status) return;
    const changed=this.db.prepare(
      'UPDATE lifecycle SET status=? WHERE obligation=?',
    ).run(status,id);
    if (changed.changes!==1) throw new Error('LIFECYCLE_WRITE_FAILED');
    this.#writes+=1;
  }

  #refreshDirectDependents(upstream:string):void {
    const dependents=this.db.prepare(
      'SELECT downstream FROM dependencies WHERE upstream=?',
    ).all(upstream) as Array<{downstream:string}>;

    for (const {downstream} of dependents) {
      const current=this.#status(downstream);
      if (!['READY','BLOCKED'].includes(current)) continue;
      const unsatisfied=(this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM dependencies d
        JOIN lifecycle l ON l.obligation=d.upstream
        WHERE d.downstream=?
          AND l.status!='DONE'
      `).get(downstream) as {count:number}).count;
      this.#write(downstream,unsatisfied===0?'READY':'BLOCKED');
    }
  }

  #blockDependentsTransitively(upstream:string):void {
    const dependents=this.db.prepare(
      'SELECT downstream FROM dependencies WHERE upstream=?',
    ).all(upstream) as Array<{downstream:string}>;

    for (const {downstream} of dependents) {
      const current=this.#status(downstream);
      if (['READY','BLOCKED'].includes(current)) {
        this.#write(downstream,'BLOCKED');
      }
      this.#blockDependentsTransitively(downstream);
    }
  }
}
