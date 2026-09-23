import {canonicalDigest} from '../../digest.ts';
import {
  gcpPathSegment,
  observeCertifiedGcpResource,
  type GcpObservationOperation,
  type GcpReadOptions,
} from './certified-observation.ts';

const CLOUD_RUN_SERVICE_SCHEMA={
  type:'object',
  properties:{
    name:{type:'string'},
    uid:{type:'string'},
    generation:{type:'string'},
    observedGeneration:{type:'string'},
    latestReadyRevision:{type:'string'},
    latestCreatedRevision:{type:'string'},
    reconciling:{type:'boolean'},
    terminalCondition:{
      type:'object',
      properties:{state:{type:'string'},reason:{type:'string'}},
    },
    etag:{type:'string'},
  },
} as const;

export const GCP_CLOUD_RUN_SERVICE_SCHEMA_SHA256=canonicalDigest(CLOUD_RUN_SERVICE_SCHEMA);

export const GCP_CLOUD_RUN_SERVICE_OPERATION:GcpObservationOperation={
  provider:'gcp',
  authority_host:'run.googleapis.com',
  api_version:'v2',
  method:'GET',
  path_template:'/v2/{name}',
  operation_id:'run.projects.locations.services.get',
  schema_sha256:GCP_CLOUD_RUN_SERVICE_SCHEMA_SHA256,
  outcomes:[{status:'200',schema:CLOUD_RUN_SERVICE_SCHEMA}],
};

export const GCP_CLOUD_RUN_SERVICE_RESPONSE_SLICE=[
  {path:'name'},
  {path:'uid'},
  {path:'generation'},
  {path:'observedGeneration',required:false},
  {path:'latestReadyRevision',required:false},
  {path:'latestCreatedRevision',required:false},
  {path:'reconciling'},
  {path:'terminalCondition.state',required:false},
  {path:'terminalCondition.reason',required:false},
  {path:'etag',required:false},
] as const;

export interface GcpCloudRunServiceCoordinate {
  project:string;
  location:string;
  service:string;
}

interface CertifiedGcpCloudRunService {
  name:string;
  uid:string;
  generation:string;
  observedGeneration?:string;
  latestReadyRevision?:string;
  latestCreatedRevision?:string;
  reconciling:boolean;
  terminalCondition?:{state?:string;reason?:string};
  etag?:string;
}

function validateCoordinate(coordinate:GcpCloudRunServiceCoordinate):void {
  gcpPathSegment(coordinate.project,'GCP_CLOUD_RUN_PROJECT_INVALID');
  gcpPathSegment(coordinate.location,'GCP_CLOUD_RUN_LOCATION_INVALID');
  gcpPathSegment(coordinate.service,'GCP_CLOUD_RUN_SERVICE_INVALID');
}

export function gcpCloudRunServiceName(coordinate:GcpCloudRunServiceCoordinate):string {
  validateCoordinate(coordinate);
  return `projects/${coordinate.project}/locations/${coordinate.location}/services/${coordinate.service}`;
}

function gcpCloudRunServicePath(coordinate:GcpCloudRunServiceCoordinate):string {
  return `/v2/projects/${gcpPathSegment(coordinate.project,'GCP_CLOUD_RUN_PROJECT_INVALID')}/locations/${gcpPathSegment(coordinate.location,'GCP_CLOUD_RUN_LOCATION_INVALID')}/services/${gcpPathSegment(coordinate.service,'GCP_CLOUD_RUN_SERVICE_INVALID')}`;
}

function reconciliationState(service:CertifiedGcpCloudRunService) {
  if (service.reconciling) return 'in-progress' as const;
  if (
    service.observedGeneration!==undefined
    && service.latestReadyRevision!==undefined
    && service.latestCreatedRevision!==undefined
    && service.observedGeneration===service.generation
    && service.latestReadyRevision===service.latestCreatedRevision
  ) return 'converged' as const;
  return 'settled-not-converged' as const;
}

export function observeCertifiedGcpCloudRunService(
  accessToken:string,
  coordinate:GcpCloudRunServiceCoordinate,
  options:GcpReadOptions={},
) {
  const requestedName=gcpCloudRunServiceName(coordinate);
  return observeCertifiedGcpResource<CertifiedGcpCloudRunService>({
    accessToken,
    operation:GCP_CLOUD_RUN_SERVICE_OPERATION,
    request:{
      path:gcpCloudRunServicePath(coordinate),
      parameters:{name:requestedName},
    },
    fields:GCP_CLOUD_RUN_SERVICE_RESPONSE_SLICE,
    observerId:'cloud-run-service',
    options,
    validate:value=>{
      if (value.name!==requestedName) {
        throw new Error('GCP_CLOUD_RUN_SERVICE_COORDINATE_MISMATCH');
      }
      if (!value.uid || !value.generation) {
        throw new Error('GCP_CLOUD_RUN_SERVICE_STATE_IDENTITY_INVALID');
      }
      for (const candidate of [
        value.observedGeneration,
        value.latestReadyRevision,
        value.latestCreatedRevision,
      ]) {
        if (candidate!==undefined && candidate.length===0) {
          throw new Error('GCP_CLOUD_RUN_SERVICE_STATE_IDENTITY_INVALID');
        }
      }
    },
    evidence:value=>({
      product:'cloud-run',
      requested_name:requestedName,
      uid:value.uid,
      reconciliation:reconciliationState(value),
    }),
  });
}
