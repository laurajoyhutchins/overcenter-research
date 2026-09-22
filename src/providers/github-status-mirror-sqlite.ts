import {DatabaseSync} from 'node:sqlite';

import {canonicalDigest} from '../digest.ts';
import {
  GithubStatusMirror,
  type CertifiedGithubStatusWebhookFact,
  type GithubStatusMirrorObservation,
  type GithubStatusProjection,
  type GithubStatusReconciliationEvidence,
  type GithubWebhookAuthority,
  type GithubWebhookDeliveryLister,
  type GithubWebhookDeliverySummary,
} from './github-status-webhook.ts';

interface FactRow {
  sequence:number|bigint;
  delivery_id:string;
  fact_digest:string;
  fact_json:string;
}

interface ReconciliationRow {
  sequence:number|bigint;
  repository_id:number|bigint;
  observed_at:string;
  evidence_digest:string;
  deliveries_json:string;
}

interface ProjectionRow {
  repository_id:number|bigint;
  commit_sha:string;
  context_key:string;
  projection_digest:string;
  projection_json:string;
}

function parseJson<T>(value:string,error:string):T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(error);
  }
}

function projectionIdentity(
  projection:GithubStatusProjection,
):[number,string,string] {
  return [
    projection.repository_id,
    projection.commit_sha,
    projection.context_key,
  ];
}

function projectionSort(
  left:GithubStatusProjection,
  right:GithubStatusProjection,
):number {
  return projectionIdentity(left)
    .join(':')
    .localeCompare(projectionIdentity(right).join(':'));
}

export class SqliteGithubStatusMirror {
  readonly path:string;
  readonly #authority:GithubWebhookAuthority;
  readonly #maxCoverageAgeMs:number;
  readonly #db:DatabaseSync;
  #mirror:GithubStatusMirror;

  constructor(
    path:string,
    authority:GithubWebhookAuthority,
    {maxCoverageAgeMs}:{maxCoverageAgeMs:number},
  ) {
    this.path=path;
    this.#authority=structuredClone(authority);
    this.#maxCoverageAgeMs=maxCoverageAgeMs;
    this.#db=new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = FULL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS github_status_facts (
        sequence INTEGER PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE,
        fact_digest TEXT NOT NULL,
        fact_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS github_status_reconciliations (
        sequence INTEGER PRIMARY KEY,
        repository_id INTEGER NOT NULL CHECK(repository_id > 0),
        observed_at TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        deliveries_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS github_status_current (
        repository_id INTEGER NOT NULL CHECK(repository_id > 0),
        commit_sha TEXT NOT NULL,
        context_key TEXT NOT NULL,
        projection_digest TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        PRIMARY KEY(repository_id,commit_sha,context_key)
      );
    `);
    this.#mirror=this.#newMirror();
    this.#rebuildFromDatabase();
  }

  ingest(
    fact:CertifiedGithubStatusWebhookFact,
  ):'applied'|'ignored'|'duplicate'|'ambiguous' {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result=this.#mirror.ingest(fact);
      if(result==='duplicate') {
        this.#db.exec('COMMIT');
        return result;
      }

      const serialized=JSON.stringify(fact);
      this.#db.prepare(`
        INSERT INTO github_status_facts(
          delivery_id,
          fact_digest,
          fact_json
        ) VALUES(?,?,?)
      `).run(
        fact.delivery_id,
        canonicalDigest(fact),
        serialized,
      );

      const projection=this.#mirror.projectionAt({
        repositoryId:fact.repository.id,
        commitSha:fact.status.commit_sha,
        context:fact.status.context,
      });
      if(!projection) throw new Error('GITHUB_STATUS_PROJECTION_MISSING_AFTER_INGEST');
      this.#writeProjection(projection);
      this.#db.exec('COMMIT');
      return result;
    } catch(error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {}
      this.#rebuildFromDatabase();
      throw error;
    }
  }

  async reconcileRepository({
    repositoryId,
    list,
  }:{
    repositoryId:number;
    list:GithubWebhookDeliveryLister;
  }):Promise<void> {
    const evidence=await this.#mirror.reconcileRepository({
      repositoryId,
      list,
    });

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare(`
        INSERT INTO github_status_reconciliations(
          repository_id,
          observed_at,
          evidence_digest,
          deliveries_json
        ) VALUES(?,?,?,?)
      `).run(
        evidence.repository_id,
        evidence.observed_at,
        canonicalDigest(evidence),
        JSON.stringify(evidence.deliveries),
      );
      this.#db.exec('COMMIT');
    } catch(error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {}
      this.#rebuildFromDatabase();
      throw error;
    }
  }

  observe({
    repositoryId,
    commitSha,
    context,
    observedAt,
  }:{
    repositoryId:number;
    commitSha:string;
    context:string;
    observedAt:string;
  }):GithubStatusMirrorObservation {
    return this.#mirror.observe({
      repositoryId,
      commitSha,
      context,
      observedAt,
    });
  }

  close():void {
    this.#db.close();
  }

  #newMirror():GithubStatusMirror {
    return new GithubStatusMirror(
      this.#authority,
      {maxCoverageAgeMs:this.#maxCoverageAgeMs},
    );
  }

  #writeProjection(projection:GithubStatusProjection):void {
    const serialized=JSON.stringify(projection);
    this.#db.prepare(`
      INSERT INTO github_status_current(
        repository_id,
        commit_sha,
        context_key,
        projection_digest,
        projection_json
      ) VALUES(?,?,?,?,?)
      ON CONFLICT(repository_id,commit_sha,context_key)
      DO UPDATE SET
        projection_digest=excluded.projection_digest,
        projection_json=excluded.projection_json
    `).run(
      projection.repository_id,
      projection.commit_sha,
      projection.context_key,
      canonicalDigest(projection),
      serialized,
    );
  }

  #rebuildFromDatabase():void {
    const rebuilt=this.#newMirror();

    const facts=this.#db.prepare(`
      SELECT sequence,delivery_id,fact_digest,fact_json
      FROM github_status_facts
      ORDER BY sequence
    `).all() as unknown as FactRow[];
    for(const row of facts) {
      const fact=parseJson<CertifiedGithubStatusWebhookFact>(
        row.fact_json,
        'GITHUB_STATUS_FACT_JSON_INVALID',
      );
      if(fact.delivery_id!==row.delivery_id) {
        throw new Error('GITHUB_STATUS_FACT_DELIVERY_ID_MISMATCH');
      }
      if(canonicalDigest(fact)!==row.fact_digest) {
        throw new Error('GITHUB_STATUS_FACT_DIGEST_MISMATCH');
      }
      rebuilt.ingest(fact);
    }

    const reconciliations=this.#db.prepare(`
      SELECT
        sequence,
        repository_id,
        observed_at,
        evidence_digest,
        deliveries_json
      FROM github_status_reconciliations
      ORDER BY sequence
    `).all() as unknown as ReconciliationRow[];
    for(const row of reconciliations) {
      const deliveries=parseJson<GithubWebhookDeliverySummary[]>(
        row.deliveries_json,
        'GITHUB_STATUS_RECONCILIATION_JSON_INVALID',
      );
      const evidence:GithubStatusReconciliationEvidence={
        repository_id:Number(row.repository_id),
        observed_at:row.observed_at,
        deliveries,
      };
      if(canonicalDigest(evidence)!==row.evidence_digest) {
        throw new Error('GITHUB_STATUS_RECONCILIATION_DIGEST_MISMATCH');
      }
      rebuilt.reconcileRepositoryEvidence(evidence);
    }

    const expected=rebuilt.projections().sort(projectionSort);
    const rows=this.#db.prepare(`
      SELECT
        repository_id,
        commit_sha,
        context_key,
        projection_digest,
        projection_json
      FROM github_status_current
      ORDER BY repository_id,commit_sha,context_key
    `).all() as unknown as ProjectionRow[];
    const persisted=rows.map(row=>{
      const projection=parseJson<GithubStatusProjection>(
        row.projection_json,
        'GITHUB_STATUS_PROJECTION_JSON_INVALID',
      );
      if(
        projection.repository_id!==Number(row.repository_id)
        || projection.commit_sha!==row.commit_sha
        || projection.context_key!==row.context_key
      ) {
        throw new Error('GITHUB_STATUS_PROJECTION_COORDINATE_MISMATCH');
      }
      if(canonicalDigest(projection)!==row.projection_digest) {
        throw new Error('GITHUB_STATUS_PROJECTION_DIGEST_MISMATCH');
      }
      return projection;
    }).sort(projectionSort);

    if(canonicalDigest(expected)!==canonicalDigest(persisted)) {
      throw new Error('GITHUB_STATUS_PROJECTION_RECONSTRUCTION_MISMATCH');
    }

    this.#mirror=rebuilt;
  }
}
