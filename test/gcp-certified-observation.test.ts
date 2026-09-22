import assert from 'node:assert/strict';
import test from 'node:test';

import {
  observeCertifiedGcpRead200,
  type GcpObservationOperation,
} from '../src/providers/gcp-certified-observation.ts';
import {
  assertGcpAuthorityHost,
  type GcpJsonGet,
} from '../src/providers/gcp-rest.ts';
import { projectResponseSlice } from '../src/provider-observation/response-slice.ts';

const SERVICE_FIELDS=[
  {path:'name'},
  {path:'uid'},
  {path:'generation'},
  {path:'observedGeneration'},
  {path:'latestReadyRevision'},
  {path:'latestCreatedRevision'},
  {path:'reconciling'},
  {path:'etag',required:false},
] as const;

const operation=():GcpObservationOperation=>({
  provider:'gcp',
  authority_host:'run.googleapis.com',
  api_version:'v2',
  method:'GET',
  path_template:'/v2/{name}',
  operation_id:'run.projects.locations.services.get',
  schema_sha256:'b'.repeat(64),
  outcomes:[{
    status:'200',
    schema:{
      type:'object',
      properties:{
        name:{type:'string'},
        uid:{type:'string'},
        generation:{type:'string'},
        observedGeneration:{type:'string'},
        latestReadyRevision:{type:'string'},
        latestCreatedRevision:{type:'string'},
        reconciling:{type:'boolean'},
        etag:{type:'string'},
        description:{type:'string'},
      },
    },
  }],
});

function service() {
  return {
    name:'projects/demo-project/locations/us-central1/services/overcenter',
    uid:'53af218b-4f39-49b7-9eb6-8f410d403d7f',
    generation:'12',
    observedGeneration:'12',
    latestReadyRevision:'projects/demo-project/locations/us-central1/services/overcenter/revisions/overcenter-00012',
    latestCreatedRevision:'projects/demo-project/locations/us-central1/services/overcenter/revisions/overcenter-00012',
    reconciling:false,
    etag:'BwYQ8-example',
    description:'not part of the authority-bearing slice',
  };
}

test('certified GCP read binds host, operation, schema, and selected response fields',()=>{
  const seen:Array<{token:string;request:Parameters<GcpJsonGet>[1]}>=[];
  const get:GcpJsonGet=(token,request)=>{
    seen.push({token,request});
    return service();
  };
  const result=observeCertifiedGcpRead200({
    accessToken:'adc-access-token',
    operation:operation(),
    request:{
      path:'/v2/projects/demo-project/locations/us-central1/services/overcenter',
      parameters:{
        name:'projects/demo-project/locations/us-central1/services/overcenter',
      },
    },
    fields:SERVICE_FIELDS,
    get,
    clock:()=> '2026-09-21T15:45:00.000Z',
    observerId:'cloud-run-service/v1',
    quotaProject:'demo-billing-project',
  });

  assert.equal(result.observed_at,'2026-09-21T15:45:00.000Z');
  assert.deepEqual(seen,[{
    token:'adc-access-token',
    request:{
      authority_host:'run.googleapis.com',
      path:'/v2/projects/demo-project/locations/us-central1/services/overcenter',
      headers:{
        Accept:'application/json',
        'X-Goog-User-Project':'demo-billing-project',
      },
    },
  }]);
  assert.equal(result.certified.contract.provider,'gcp');
  assert.equal(result.certified.contract.api_version,'v2');
  assert.equal(result.certified.contract.operation_id,'run.projects.locations.services.get');
  assert.equal(result.certified.contract.schema_sha256,'b'.repeat(64));
  assert.equal(result.certified.request.authority_host,'run.googleapis.com');
  assert.equal(result.certified.request.authorization,'bearer');
  assert.equal(JSON.stringify(result.certified.request).includes('adc-access-token'),false);
  assert.deepEqual(
    result.certified.structural_validation.validated_paths,
    SERVICE_FIELDS.map(field=>field.path),
  );

  const projected=projectResponseSlice(result.certified.outcome.value,SERVICE_FIELDS);
  assert.equal(JSON.stringify(projected).includes('description'),false);
  assert.deepEqual(projected,serviceWithoutDescription());
});

function serviceWithoutDescription() {
  const {description:_,...value}=service();
  return value;
}

test('GCP observation refuses non-Google API authority before provider access',()=>{
  let called=false;
  assert.throws(
    ()=>observeCertifiedGcpRead200({
      accessToken:'token',
      operation:{...operation(),authority_host:'example.invalid'},
      request:{path:'/v2/projects/p/locations/l/services/s',parameters:{}},
      fields:SERVICE_FIELDS,
      get:()=>{
        called=true;
        return service();
      },
      observerId:'test',
    }),
    /GCP_AUTHORITY_HOST_INVALID/,
  );
  assert.equal(called,false);
});

test('GCP observation fails closed on schema mismatch',()=>{
  assert.throws(
    ()=>observeCertifiedGcpRead200({
      accessToken:'token',
      operation:operation(),
      request:{path:'/v2/projects/p/locations/l/services/s',parameters:{}},
      fields:SERVICE_FIELDS,
      get:()=>({...service(),reconciling:'false'}),
      observerId:'test',
    }),
    /RESPONSE_SLICE_VALUE_MISMATCH:reconciling/,
  );
});

test('GCP observation requires a pinned schema digest and access token',()=>{
  assert.throws(
    ()=>observeCertifiedGcpRead200({
      accessToken:'',
      operation:operation(),
      request:{path:'/v2/projects/p/locations/l/services/s',parameters:{}},
      fields:SERVICE_FIELDS,
      get:()=>service(),
      observerId:'test',
    }),
    /GCP_ACCESS_TOKEN_REQUIRED/,
  );
  assert.throws(
    ()=>observeCertifiedGcpRead200({
      accessToken:'token',
      operation:{...operation(),schema_sha256:'not-pinned'},
      request:{path:'/v2/projects/p/locations/l/services/s',parameters:{}},
      fields:SERVICE_FIELDS,
      get:()=>service(),
      observerId:'test',
    }),
    /GCP_SCHEMA_DIGEST_INVALID/,
  );
});

test('GCP transport authority accepts Google API hosts and rejects lookalikes',()=>{
  assert.equal(assertGcpAuthorityHost('run.googleapis.com'),'run.googleapis.com');
  assert.equal(
    assertGcpAuthorityHost('us-central1-run.googleapis.com'),
    'us-central1-run.googleapis.com',
  );
  for (const host of [
    'googleapis.com.evil.invalid',
    'run.googleapis.com.evil.invalid',
    'metadata.google.internal',
    'RUN.GOOGLEAPIS.COM',
  ]) {
    assert.throws(()=>assertGcpAuthorityHost(host),/GCP_AUTHORITY_HOST_INVALID/);
  }
});
