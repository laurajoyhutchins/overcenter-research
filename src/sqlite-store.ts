import { DatabaseSync } from 'node:sqlite';

import { canonicalDigest } from './digest.ts';
import {
  factCommitFromFiles,
  type DurableFactStore,
} from './fact-store.ts';
import type { FactCommit } from './facts.ts';

const COMMIT_SCHEMA='overcenter-sqlite-fact-commit-v1' as const;

interface AuthorityRow {
  head:string|null;
  sequence:number|bigint;
}

interface CommitRow {
  sequence:number|bigint;
  commit_id:string;
  parent_id:string|null;
  message:string;
  files_json:string;
}

export class SqliteFactStore implements DurableFactStore {
  readonly path:string;
  readonly #db:DatabaseSync;

  constructor(path:string) {
    this.path=path;
    this.#db=new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = FULL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS fact_commits (
        sequence INTEGER PRIMARY KEY,
        commit_id TEXT NOT NULL UNIQUE,
        parent_id TEXT REFERENCES fact_commits(commit_id),
        message TEXT NOT NULL,
        files_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS authority (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        head TEXT REFERENCES fact_commits(commit_id),
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        CHECK(
          (head IS NULL AND sequence = 0)
          OR (head IS NOT NULL AND sequence > 0)
        )
      );

      INSERT OR IGNORE INTO authority(singleton,head,sequence)
      VALUES(1,NULL,0);
    `);
  }

  head():string|null {
    const row=this.#authority();
    return row.head;
  }

  append(
    expectedHead:string|null,
    message:string,
    files:Record<string,unknown>={},
  ):string|null {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const authority=this.#authority();
      if (authority.head!==expectedHead) {
        this.#db.exec('ROLLBACK');
        return null;
      }

      const sequence=Number(authority.sequence)+1;
      const commitId=canonicalDigest({
        schema:COMMIT_SCHEMA,
        sequence,
        parent:expectedHead,
        message,
        files,
      });
      const filesJson=JSON.stringify(files);

      this.#db.prepare(`
        INSERT INTO fact_commits(
          sequence,
          commit_id,
          parent_id,
          message,
          files_json
        ) VALUES(?,?,?,?,?)
      `).run(
        sequence,
        commitId,
        expectedHead,
        message,
        filesJson,
      );

      const advanced=this.#db.prepare(`
        UPDATE authority
        SET head = ?, sequence = ?
        WHERE singleton = 1
          AND sequence = ?
          AND (
            (head IS NULL AND ? IS NULL)
            OR head = ?
          )
      `).run(
        commitId,
        sequence,
        Number(authority.sequence),
        expectedHead,
        expectedHead,
      );
      if (advanced.changes!==1) {
        this.#db.exec('ROLLBACK');
        return null;
      }

      this.#db.exec('COMMIT');
      return commitId;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }

  history(head:string):FactCommit[] {
    const terminal=this.#db.prepare(`
      SELECT sequence
      FROM fact_commits
      WHERE commit_id = ?
    `).get(head) as {sequence:number|bigint}|undefined;
    if (!terminal) throw new Error('UNKNOWN_AUTHORITY_HEAD');

    const rows=this.#db.prepare(`
      SELECT sequence, commit_id, parent_id, message, files_json
      FROM fact_commits
      WHERE sequence <= ?
      ORDER BY sequence
    `).all(Number(terminal.sequence)) as unknown as CommitRow[];

    const history:FactCommit[]=[];
    let expectedParent:string|null=null;
    let expectedSequence=1;
    for (const row of rows) {
      const sequence=Number(row.sequence);
      if (sequence!==expectedSequence) {
        throw new Error('FACT_HISTORY_SEQUENCE_GAP');
      }
      if (row.parent_id!==expectedParent) {
        throw new Error('FACT_HISTORY_PARENT_MISMATCH');
      }
      const files=JSON.parse(row.files_json) as Record<string,unknown>;
      const expectedCommitId=canonicalDigest({
        schema:COMMIT_SCHEMA,
        sequence,
        parent:row.parent_id,
        message:row.message,
        files,
      });
      if (row.commit_id!==expectedCommitId) {
        throw new Error('FACT_COMMIT_DIGEST_MISMATCH');
      }
      history.push(
        factCommitFromFiles(
          row.commit_id,
          row.parent_id,
          files,
        ),
      );
      expectedParent=row.commit_id;
      expectedSequence+=1;
    }

    if (history.at(-1)?.commit!==head) {
      throw new Error('FACT_HISTORY_HEAD_MISMATCH');
    }
    return history;
  }

  close():void {
    this.#db.close();
  }

  #authority():AuthorityRow {
    const row=this.#db.prepare(`
      SELECT head, sequence
      FROM authority
      WHERE singleton = 1
    `).get() as AuthorityRow|undefined;
    if (!row) throw new Error('AUTHORITY_ROW_MISSING');
    return row;
  }
}
