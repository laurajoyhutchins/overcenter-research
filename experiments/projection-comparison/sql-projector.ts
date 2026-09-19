import { DatabaseSync } from 'node:sqlite';
import type {
  ProjectionInput,
  ProjectStatus,
  StatusMap,
} from './model.ts';

export function projectWithSql(input:ProjectionInput):StatusMap {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE obligations (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE dependencies (
        downstream TEXT NOT NULL,
        upstream TEXT NOT NULL
      );
      CREATE TABLE semantic_keys (
        obligation TEXT PRIMARY KEY,
        semantic_key TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        obligation TEXT NOT NULL,
        semantic_key TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      CREATE TABLE receipts (
        run_id TEXT NOT NULL,
        disposition TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      CREATE TABLE admissible_runs (
        run_id TEXT PRIMARY KEY
      );
    `);

    const insertObligation=db.prepare(
      'INSERT INTO obligations(id) VALUES (?)',
    );
    for (const id of input.obligations) insertObligation.run(id);

    const insertDependency=db.prepare(
      'INSERT INTO dependencies(downstream,upstream) VALUES (?,?)',
    );
    for (const edge of input.dependencies) {
      insertDependency.run(edge.downstream,edge.upstream);
    }

    const insertKey=db.prepare(
      'INSERT INTO semantic_keys(obligation,semantic_key) VALUES (?,?)',
    );
    for (const [id,key] of input.semanticKeys) {
      if (key) insertKey.run(id,key);
    }

    const insertRun=db.prepare(
      'INSERT INTO runs(id,obligation,semantic_key,sequence) VALUES (?,?,?,?)',
    );
    for (const run of input.runs) {
      insertRun.run(run.id,run.obligation,run.semanticKey,run.sequence);
    }

    const insertReceipt=db.prepare(
      'INSERT INTO receipts(run_id,disposition,sequence) VALUES (?,?,?)',
    );
    for (const receipt of input.receipts) {
      insertReceipt.run(
        receipt.run,
        receipt.disposition,
        receipt.sequence,
      );
    }

    const insertAdmissible=db.prepare(
      'INSERT INTO admissible_runs(run_id) VALUES (?)',
    );
    for (const runId of input.admissibleRuns) insertAdmissible.run(runId);

    const rows=db.prepare(`
      WITH
      latest_receipt_sequence AS (
        SELECT run_id, MAX(sequence) AS sequence
        FROM receipts
        GROUP BY run_id
      ),
      latest_receipt AS (
        SELECT r.run_id, r.disposition
        FROM receipts r
        JOIN latest_receipt_sequence latest
          ON latest.run_id = r.run_id
         AND latest.sequence = r.sequence
      ),
      matching_runs AS (
        SELECT r.id, r.obligation, r.sequence
        FROM runs r
        JOIN semantic_keys current
          ON current.obligation = r.obligation
         AND current.semantic_key = r.semantic_key
      ),
      done AS (
        SELECT DISTINCT matching.obligation
        FROM matching_runs matching
        JOIN latest_receipt receipt
          ON receipt.run_id = matching.id
         AND receipt.disposition = 'DONE'
        JOIN admissible_runs admissible
          ON admissible.run_id = matching.id
      ),
      latest_matching_sequence AS (
        SELECT obligation, MAX(sequence) AS sequence
        FROM matching_runs
        GROUP BY obligation
      ),
      latest_matching AS (
        SELECT matching.id, matching.obligation
        FROM matching_runs matching
        JOIN latest_matching_sequence latest
          ON latest.obligation = matching.obligation
         AND latest.sequence = matching.sequence
      ),
      latest_state AS (
        SELECT
          latest.obligation,
          latest.id AS run_id,
          receipt.disposition
        FROM latest_matching latest
        LEFT JOIN latest_receipt receipt
          ON receipt.run_id = latest.id
      )
      SELECT
        obligation.id,
        CASE
          WHEN done.obligation IS NOT NULL
            THEN 'DONE'
          WHEN latest.run_id IS NOT NULL
            AND latest.disposition IS NULL
            THEN 'EXECUTING'
          WHEN latest.disposition = 'WAITING'
            THEN 'WAITING'
          WHEN latest.disposition = 'RECOVERY_REQUIRED'
            THEN 'RECOVERY_REQUIRED'
          WHEN current.semantic_key IS NULL
            THEN 'BLOCKED'
          WHEN EXISTS (
            SELECT 1
            FROM dependencies dependency
            LEFT JOIN done upstream_done
              ON upstream_done.obligation = dependency.upstream
            WHERE dependency.downstream = obligation.id
              AND upstream_done.obligation IS NULL
          )
            THEN 'BLOCKED'
          ELSE 'READY'
        END AS status
      FROM obligations obligation
      LEFT JOIN done
        ON done.obligation = obligation.id
      LEFT JOIN latest_state latest
        ON latest.obligation = obligation.id
      LEFT JOIN semantic_keys current
        ON current.obligation = obligation.id
      ORDER BY obligation.id
    `).all() as Array<{id:string;status:ProjectStatus}>;

    return new Map(rows.map(row=>[row.id,row.status]));
  } finally {
    db.close();
  }
}
