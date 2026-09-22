import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GCP_CLOUD_RUN_SERVICE_SCHEMA_SHA256,
  observeCertifiedGcpCloudRunService,
} from '../src/providers/gcp-cloud-run-service.ts';
import {
  GCP_CLOUD_SQL_INSTANCE_SCHEMA_SHA256,
  observeCertifiedGcpCloudSqlInstance,
} from '../src/providers/gcp-cloud-sql-instance.ts';
import type { GcpJsonGet } from '../src/providers/gcp-rest.ts';

const runCoordinate={
  project:'demo-project',
  location:'us-central1',
  service:'overcenter',
};

function runService(overrides:Record<string,unknown>={}) {
  return {
    name:'projects/demo-project/locations/us-central1/services/overcenter',
    uid:'53af218b-4f39-49b7-9eb6-8f410d403d7f',
    generation:'12',
    observedGeneration:'12',
    latestReadyRevision:'projects/demo-project/locations/us-central1/services/overcenter/revisions/overcenter-00012',
    latestCreatedRevision:'projects/demo-project/locations/us-central1/services/overcenter/revisions/overcenter-00012',
    reconciling:false,
    terminalCondition:{state:'CONDITION_SUCCEEDED',reason:'Ready'},
    etag:'BwYQ8-example',
    description:'uncertified',
    ...overrides,
  };
}

test('Cloud Run reader binds exact service identity and convergence state',()=>{
  const calls:Parameters<GcpJsonGet>[1][]=[];
  const result=observeCertifiedGcpCloudRunService(
    'token',
    runCoordinate,
    {
      clock:()=> '2026-09-21T16:00:00.000Z',
      get:(_token,request)=>{
        calls.push(request);
        return runService();
      },
    },
  );

  assert.equal(result.state,'observed');
  if (result.state!=='observed') return;
  assert.deepEqual(calls,[{
    authority_host:'run.googleapis.com',
    path:'/v2/projects/demo-project/locations/us-central1/services/overcenter',
    headers:{Accept:'application/json'},
  }]);
  assert.equal(result.evidence.schema_sha256,GCP_CLOUD_RUN_SERVICE_SCHEMA_SHA256);
  assert.equal(result.evidence.requested_name,runService().name);
  assert.equal(result.evidence.uid,runService().uid);
  assert.equal(result.evidence.reconciliation,'converged');
  assert.equal(result.evidence.negative_evidence_authoritative,false);
  assert.equal(JSON.stringify(result.value).includes('uncertified'),false);
});

test('Cloud Run distinguishes active reconciliation and settled non-convergence',()=>{
  const inProgress=observeCertifiedGcpCloudRunService(
    'token',
    runCoordinate,
    {get:()=>runService({reconciling:true,observedGeneration:'11'})},
  );
  assert.equal(inProgress.state,'observed');
  if (inProgress.state==='observed') {
    assert.equal(inProgress.evidence.reconciliation,'in-progress');
  }

  const failed=observeCertifiedGcpCloudRunService(
    'token',
    runCoordinate,
    {
      get:()=>{
        const {
          latestReadyRevision:_ready,
          latestCreatedRevision:_created,
          observedGeneration:_observed,
          ...body
        }=runService({
          reconciling:false,
          terminalCondition:{state:'CONDITION_FAILED',reason:'RevisionFailed'},
        });
        return body;
      },
    },
  );
  assert.equal(failed.state,'observed');
  if (failed.state==='observed') {
    assert.equal(failed.evidence.reconciliation,'settled-not-converged');
    assert.equal(failed.value.terminalCondition?.state,'CONDITION_FAILED');
    assert.equal(failed.value.latestReadyRevision,undefined);
  }
});

test('Cloud Run rejects malformed coordinates before provider access',()=>{
  let called=false;
  const result=observeCertifiedGcpCloudRunService(
    'token',
    {...runCoordinate,service:'overcenter/other'},
    {
      get:()=>{
        called=true;
        return runService();
      },
    },
  );
  assert.equal(result.state,'indeterminate');
  assert.equal(called,false);
});

test('Cloud Run fails closed if provider returns another service at the requested path',()=>{
  const result=observeCertifiedGcpCloudRunService(
    'token',
    runCoordinate,
    {
      get:()=>runService({
        name:'projects/demo-project/locations/us-central1/services/other',
      }),
    },
  );

  assert.deepEqual(result,{
    state:'indeterminate',
    observation_error:'GCP_CLOUD_RUN_SERVICE_COORDINATE_MISMATCH',
  });
});

const sqlCoordinate={project:'future-project',instance:'overcenter-db'};

function sqlInstance(overrides:Record<string,unknown>={}) {
  return {
    kind:'sql#instance',
    state:'RUNNABLE',
    databaseVersion:'POSTGRES_16',
    settings:{settingsVersion:'42'},
    etag:'deprecated-do-not-certify',
    project:'future-project',
    backendType:'SECOND_GEN',
    selfLink:'https://sqladmin.googleapis.com/sql/v1beta4/projects/future-project/instances/overcenter-db',
    connectionName:'future-project:us-central1:overcenter-db',
    name:'overcenter-db',
    region:'us-central1',
    gceZone:'us-central1-a',
    serviceAccountEmailAddress:'uncertified@example.invalid',
    ...overrides,
  };
}

test('Cloud SQL reader uses settingsVersion as the certified concurrency identity',()=>{
  const calls:Parameters<GcpJsonGet>[1][]=[];
  const result=observeCertifiedGcpCloudSqlInstance(
    'token',
    sqlCoordinate,
    {
      clock:()=> '2026-09-21T16:01:00.000Z',
      get:(_token,request)=>{
        calls.push(request);
        return sqlInstance();
      },
    },
  );

  assert.equal(result.state,'observed');
  if (result.state!=='observed') return;
  assert.deepEqual(calls,[{
    authority_host:'sqladmin.googleapis.com',
    path:'/sql/v1beta4/projects/future-project/instances/overcenter-db',
    headers:{Accept:'application/json'},
  }]);
  assert.equal(result.evidence.schema_sha256,GCP_CLOUD_SQL_INSTANCE_SCHEMA_SHA256);
  assert.equal(result.evidence.settings_version,'42');
  assert.equal(result.value.settings.settingsVersion,'42');
  assert.equal(result.value.state,'RUNNABLE');
  assert.equal(JSON.stringify(result.value).includes('deprecated-do-not-certify'),false);
  assert.equal(JSON.stringify(result.value).includes('uncertified@example.invalid'),false);
});

test('Cloud SQL fails closed on project, instance, or settingsVersion mismatch',()=>{
  for (const body of [
    sqlInstance({project:'other-project'}),
    sqlInstance({name:'other-db'}),
    sqlInstance({settings:{settingsVersion:''}}),
  ]) {
    const result=observeCertifiedGcpCloudSqlInstance(
      'token',
      sqlCoordinate,
      {get:()=>body},
    );
    assert.equal(result.state,'indeterminate');
  }
});

test('GCP service readers return indeterminate on provider failures, never absence',()=>{
  const failure=()=>{ throw new Error('provider unavailable'); };
  const run=observeCertifiedGcpCloudRunService(
    'token',
    runCoordinate,
    {get:failure},
  );
  const sql=observeCertifiedGcpCloudSqlInstance(
    'token',
    sqlCoordinate,
    {get:failure},
  );

  assert.deepEqual(run,{
    state:'indeterminate',
    observation_error:'provider unavailable',
  });
  assert.deepEqual(sql,{
    state:'indeterminate',
    observation_error:'provider unavailable',
  });
});
