import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export class OvercenterKernel {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS obligations (
        id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        deps_json TEXT NOT NULL,
        packet_json TEXT NOT NULL,
        postcondition_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN
          ('READY','EXECUTING','WAITING','RECOVERY_REQUIRED','DONE'))
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        obligation_id TEXT NOT NULL REFERENCES obligations(id),
        revision TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('ACTIVE','SETTLED','INTERRUPTED')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        disposition TEXT NOT NULL,
        verified INTEGER NOT NULL,
        observed_json TEXT NOT NULL,
        settled_at TEXT NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  define({ id, revision, deps = [], packet = {}, postcondition }) {
    this.db.prepare(`
      INSERT INTO obligations
        (id, revision, deps_json, packet_json, postcondition_json, status)
      VALUES (?, ?, ?, ?, ?, 'READY')
    `).run(id, revision, JSON.stringify(deps), JSON.stringify(packet), JSON.stringify(postcondition));
  }

  inspect() {
    return this.db.prepare('SELECT * FROM obligations ORDER BY id').all().map(row => ({
      id: row.id,
      revision: row.revision,
      deps: JSON.parse(row.deps_json),
      packet: JSON.parse(row.packet_json),
      postcondition: JSON.parse(row.postcondition_json),
      status: row.status,
    }));
  }

  deriveReadyWork() {
    const all = this.inspect();
    const done = new Set(all.filter(x => x.status === 'DONE').map(x => x.id));
    return all.find(x => x.status === 'READY' && x.deps.every(dep => done.has(dep))) ?? null;
  }

  claim(id, expectedRevision) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const work = this.db.prepare('SELECT * FROM obligations WHERE id = ?').get(id);
      if (!work) throw new Error(`unknown obligation: ${id}`);
      if (work.revision !== expectedRevision) throw new Error('STALE_REVISION');
      if (work.status !== 'READY') throw new Error('NOT_READY');

      const run = {
        id: randomUUID(),
        obligation_id: id,
        revision: expectedRevision,
        state: 'ACTIVE',
        created_at: new Date().toISOString(),
      };
      this.db.prepare(`
        INSERT INTO runs (id, obligation_id, revision, state, created_at)
        VALUES (?, ?, ?, 'ACTIVE', ?)
      `).run(run.id, id, expectedRevision, run.created_at);
      const updated = this.db.prepare(`
        UPDATE obligations SET status = 'EXECUTING'
        WHERE id = ? AND revision = ? AND status = 'READY'
      `).run(id, expectedRevision);
      if (updated.changes !== 1) throw new Error('CLAIM_LOST');
      this.db.exec('COMMIT');
      return run;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  settle(runId, { disposition, observed = {}, verified = false }) {
    if (disposition === 'DONE' && !verified) {
      throw new Error('UNVERIFIED_DONE');
    }
    if (!['DONE', 'READY', 'WAITING', 'RECOVERY_REQUIRED'].includes(disposition)) {
      throw new Error(`invalid disposition: ${disposition}`);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
      if (!run) throw new Error('UNKNOWN_RUN');
      if (run.state !== 'ACTIVE') {
        const prior = this.db.prepare('SELECT * FROM receipts WHERE run_id = ?').get(runId);
        this.db.exec('COMMIT');
        return prior ? this.#receipt(prior) : null;
      }
      const work = this.db.prepare('SELECT * FROM obligations WHERE id = ?').get(run.obligation_id);
      if (!work || work.status !== 'EXECUTING' || work.revision !== run.revision) {
        throw new Error('AUTHORITY_LOST');
      }

      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO receipts (run_id, disposition, verified, observed_json, settled_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(runId, disposition, verified ? 1 : 0, JSON.stringify(observed), now);
      this.db.prepare('UPDATE runs SET state = ? WHERE id = ?').run('SETTLED', runId);
      this.db.prepare('UPDATE obligations SET status = ? WHERE id = ?').run(disposition, work.id);
      this.db.exec('COMMIT');
      return { run_id: runId, disposition, verified, observed, settled_at: now };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recoverInterrupted() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare(`
        SELECT r.id, r.obligation_id
        FROM runs r JOIN obligations o ON o.id = r.obligation_id
        WHERE r.state = 'ACTIVE' AND o.status = 'EXECUTING'
      `).all();
      for (const run of active) {
        this.db.prepare("UPDATE runs SET state = 'INTERRUPTED' WHERE id = ?").run(run.id);
        this.db.prepare("UPDATE obligations SET status = 'RECOVERY_REQUIRED' WHERE id = ?").run(run.obligation_id);
      }
      this.db.exec('COMMIT');
      return active.length;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  reconcile(runId, observed, verify) {
    const run = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!run) throw new Error('UNKNOWN_RUN');
    const work = this.db.prepare('SELECT * FROM obligations WHERE id = ?').get(run.obligation_id);
    if (!work) throw new Error('UNKNOWN_OBLIGATION');
    if (work.revision !== run.revision) throw new Error('STALE_REVISION');

    const verified = Boolean(verify(JSON.parse(work.postcondition_json), observed));
    if (verified) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const now = new Date().toISOString();
        const prior = this.db.prepare('SELECT * FROM receipts WHERE run_id = ?').get(runId);
        if (!prior) {
          this.db.prepare(`
            INSERT INTO receipts (run_id, disposition, verified, observed_json, settled_at)
            VALUES (?, 'DONE', 1, ?, ?)
          `).run(runId, JSON.stringify(observed), now);
        }
        this.db.prepare("UPDATE runs SET state = 'SETTLED' WHERE id = ?").run(runId);
        this.db.prepare("UPDATE obligations SET status = 'DONE' WHERE id = ?").run(work.id);
        this.db.exec('COMMIT');
        return { disposition: 'DONE', verified: true, observed };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }

    if (observed.mutation_certainty === 'absent') {
      this.db.prepare("UPDATE obligations SET status = 'READY' WHERE id = ?").run(work.id);
      return { disposition: 'READY', verified: false, observed };
    }
    return { disposition: 'RECOVERY_REQUIRED', verified: false, observed };
  }

  receipts() {
    return this.db.prepare('SELECT * FROM receipts ORDER BY settled_at, run_id').all().map(row => this.#receipt(row));
  }

  #receipt(row) {
    return {
      run_id: row.run_id,
      disposition: row.disposition,
      verified: Boolean(row.verified),
      observed: JSON.parse(row.observed_json),
      settled_at: row.settled_at,
    };
  }
}

export async function runCoreLoop(kernel, { execute, observe, verify, maxAdvances = 100 }) {
  for (let i = 0; i < maxAdvances; i += 1) {
    const work = kernel.deriveReadyWork();
    if (!work) return { state: 'IDLE', advances: i };

    const run = kernel.claim(work.id, work.revision);
    let outcome;
    try {
      outcome = await execute(work.packet, run);
    } catch (error) {
      outcome = { kind: 'execution-error', error: String(error?.message || error), may_have_mutated: true };
    }

    const observed = await observe(work, run, outcome);
    const verified = Boolean(verify(work.postcondition, observed));

    if (verified) {
      kernel.settle(run.id, { disposition: 'DONE', observed, verified: true });
      continue;
    }
    if (observed.mutation_certainty === 'uncertain' || outcome?.may_have_mutated === true) {
      kernel.settle(run.id, { disposition: 'RECOVERY_REQUIRED', observed });
      return { state: 'RECOVERY_REQUIRED', work: work.id, run: run.id, advances: i + 1 };
    }
    if (outcome?.kind === 'judgment-required') {
      kernel.settle(run.id, { disposition: 'WAITING', observed });
      return { state: 'WAITING', work: work.id, run: run.id, advances: i + 1 };
    }

    kernel.settle(run.id, { disposition: 'READY', observed });
  }
  return { state: 'BUDGET_EXHAUSTED', advances: maxAdvances };
}
