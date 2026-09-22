import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';

import {
  createGithubAppWebhookDeliveryLister,
  type GithubAppWebhookHttpGet,
} from '../src/providers/github-app-webhook-deliveries.ts';
import {
  certifyGithubStatusWebhook,
  type GithubWebhookAuthority,
} from '../src/providers/github-status-webhook.ts';
import {SqliteGithubStatusMirror} from '../src/providers/github-status-mirror-sqlite.ts';

const SECRET='mirror-secret';
const SHA='a'.repeat(40);
const AUTHORITY:GithubWebhookAuthority={
  hook_id:9001,
  installation_target_id:7001,
  installation_target_type:'integration',
  installation_id:77,
};

function payload({
  id=1,
  state='success',
  updatedAt='2026-09-21T06:00:00Z',
}:{
  id?:number;
  state?:'error'|'failure'|'pending'|'success';
  updatedAt?:string;
}={}):string {
  return JSON.stringify({
    id,
    sha:SHA,
    context:'overcenter/proof',
    state,
    created_at:'2026-09-21T05:59:00Z',
    updated_at:updatedAt,
    repository:{id:42,full_name:'acme/widget'},
    installation:{id:AUTHORITY.installation_id},
  });
}

function fact(body:string,deliveryId:string) {
  return certifyGithubStatusWebhook({
    secret:SECRET,
    headers:{
      'x-hub-signature-256':`sha256=${createHmac('sha256',SECRET).update(body).digest('hex')}`,
      'x-github-event':'status',
      'x-github-delivery':deliveryId,
      'x-github-hook-id':String(AUTHORITY.hook_id),
      'x-github-hook-installation-target-id':String(AUTHORITY.installation_target_id),
      'x-github-hook-installation-target-type':AUTHORITY.installation_target_type,
    },
    body,
    receivedAt:'2026-09-21T06:00:01Z',
    expectedAuthority:AUTHORITY,
  });
}

function delivery(guid:string,id=1) {
  return {
    id,
    guid,
    delivered_at:'2026-09-21T06:00:01Z',
    redelivery:false,
    duration:0.1,
    status:'OK',
    status_code:200,
    event:'status',
    action:null,
    installation_id:AUTHORITY.installation_id,
    repository_id:42,
    throttled_at:null,
  };
}

test('SQLite status mirror reconstructs certified current state after restart',async()=>{
  const root=mkdtempSync(join(tmpdir(),'overcenter-status-mirror-'));
  const database=join(root,'provider-observation.sqlite');
  const deliveryId='11111111-1111-1111-1111-111111111111';
  try {
    const first=new SqliteGithubStatusMirror(
      database,
      AUTHORITY,
      {maxCoverageAgeMs:60_000},
    );
    first.ingest(fact(payload(),deliveryId));

    const get:GithubAppWebhookHttpGet=async(_jwt,path)=>{
      assert.equal(path,'/app/hook/deliveries?per_page=100');
      return {
        status:200,
        body:JSON.stringify([delivery(deliveryId)]),
        headers:{date:'Mon, 21 Sep 2026 06:01:00 GMT'},
      };
    };
    await first.reconcileRepository({
      repositoryId:42,
      list:createGithubAppWebhookDeliveryLister('app-jwt',{
        expectedHookId:AUTHORITY.hook_id,
        get,
      }),
    });

    assert.equal(
      first.observe({
        repositoryId:42,
        commitSha:SHA,
        context:'overcenter/proof',
        observedAt:'2026-09-21T06:01:30Z',
      }).state,
      'present',
    );
    first.close();

    const fresh=new SqliteGithubStatusMirror(
      database,
      AUTHORITY,
      {maxCoverageAgeMs:60_000},
    );
    try {
      const observed=fresh.observe({
        repositoryId:42,
        commitSha:SHA,
        context:'OVERCENTER/PROOF',
        observedAt:'2026-09-21T06:01:30Z',
      });
      assert.equal(observed.state,'present');
      if(observed.state==='present') {
        assert.equal(observed.actual_state,'success');
        assert.equal(observed.evidence.delivery_id,deliveryId);
        assert.equal(observed.evidence.coverage_through,'2026-09-21T06:01:00.000Z');
      }
    } finally {
      fresh.close();
    }

    const db=new DatabaseSync(database);
    try {
      const tables=db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type='table'
          AND name LIKE 'github_status_%'
        ORDER BY name
      `).all().map(row=>String(row.name));
      assert.deepEqual(tables,[
        'github_status_current',
        'github_status_facts',
        'github_status_reconciliations',
      ]);
      assert.equal(
        Number((db.prepare('SELECT COUNT(*) AS count FROM github_status_facts').get() as {count:number|bigint}).count),
        1,
      );
      assert.equal(
        Number((db.prepare('SELECT COUNT(*) AS count FROM github_status_reconciliations').get() as {count:number|bigint}).count),
        1,
      );
      assert.equal(
        Number((db.prepare('SELECT COUNT(*) AS count FROM github_status_current').get() as {count:number|bigint}).count),
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('SQLite status mirror preserves provider ordering across restart',async()=>{
  const root=mkdtempSync(join(tmpdir(),'overcenter-status-order-'));
  const database=join(root,'provider-observation.sqlite');
  const newer='22222222-2222-2222-2222-222222222222';
  const older='23222222-2222-2222-2222-222222222222';
  try {
    const mirror=new SqliteGithubStatusMirror(
      database,
      AUTHORITY,
      {maxCoverageAgeMs:60_000},
    );
    mirror.ingest(fact(payload({
      id:2,
      state:'success',
      updatedAt:'2026-09-21T06:00:02Z',
    }),newer));
    assert.equal(
      mirror.ingest(fact(payload({
        id:1,
        state:'failure',
        updatedAt:'2026-09-21T06:00:01Z',
      }),older)),
      'ignored',
    );
    await mirror.reconcileRepository({
      repositoryId:42,
      list:async()=>({
        deliveries:[delivery(newer,2),delivery(older,1)],
        next_cursor:null,
        observed_at:'2026-09-21T06:01:00Z',
      }),
    });
    mirror.close();

    const fresh=new SqliteGithubStatusMirror(
      database,
      AUTHORITY,
      {maxCoverageAgeMs:60_000},
    );
    try {
      const observed=fresh.observe({
        repositoryId:42,
        commitSha:SHA,
        context:'overcenter/proof',
        observedAt:'2026-09-21T06:01:10Z',
      });
      assert.equal(observed.state,'present');
      if(observed.state==='present') assert.equal(observed.actual_state,'success');
    } finally {
      fresh.close();
    }
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('SQLite status mirror rejects journal tampering on restart',()=>{
  const root=mkdtempSync(join(tmpdir(),'overcenter-status-corrupt-'));
  const database=join(root,'provider-observation.sqlite');
  const deliveryId='33333333-3333-3333-3333-333333333333';
  try {
    const mirror=new SqliteGithubStatusMirror(
      database,
      AUTHORITY,
      {maxCoverageAgeMs:60_000},
    );
    mirror.ingest(fact(payload(),deliveryId));
    mirror.close();

    const db=new DatabaseSync(database);
    try {
      db.prepare(`
        UPDATE github_status_facts
        SET fact_json = ?
        WHERE delivery_id = ?
      `).run(JSON.stringify({tampered:true}),deliveryId);
    } finally {
      db.close();
    }

    assert.throws(
      ()=>new SqliteGithubStatusMirror(
        database,
        AUTHORITY,
        {maxCoverageAgeMs:60_000},
      ),
      /GITHUB_STATUS_FACT_DELIVERY_ID_MISMATCH|GITHUB_STATUS_FACT_DIGEST_MISMATCH/,
    );
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test('SQLite status mirror rejects materialized projection drift on restart',()=>{
  const root=mkdtempSync(join(tmpdir(),'overcenter-status-projection-'));
  const database=join(root,'provider-observation.sqlite');
  const deliveryId='44444444-4444-4444-4444-444444444444';
  try {
    const mirror=new SqliteGithubStatusMirror(
      database,
      AUTHORITY,
      {maxCoverageAgeMs:60_000},
    );
    mirror.ingest(fact(payload(),deliveryId));
    mirror.close();

    const db=new DatabaseSync(database);
    try {
      db.prepare(`
        UPDATE github_status_current
        SET projection_json = ?
      `).run(JSON.stringify({
        repository_id:42,
        commit_sha:SHA,
        context_key:'overcenter/proof',
        entry:{state:'present',fact:{tampered:true}},
      }));
    } finally {
      db.close();
    }

    assert.throws(
      ()=>new SqliteGithubStatusMirror(
        database,
        AUTHORITY,
        {maxCoverageAgeMs:60_000},
      ),
      /GITHUB_STATUS_PROJECTION_DIGEST_MISMATCH/,
    );
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
