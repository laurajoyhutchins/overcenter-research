import { canonicalDigest } from '../digest.ts';
import { projectResponseSlice } from '../provider-observation/response-slice.ts';
import {
  observeCertifiedGcpRead200,
  type GcpObservationOperation,
} from './gcp-certified-observation.ts';
import type { GcpJsonGet } from './gcp-rest.ts';

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
      properties:{
        state:{type:'string'},
        reason:{type:'string'},
      },
    },
    etag:{type:'string'},
  },
} as const;

export const GCP_CLOUD_RUN_SERVICE_SCHEMA_SHA256=
  canonicalDigest(CLOUD_RUN_SERVICE_SCHEMA);

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

export interface CertifiedGcpCloudRunService {
  name:string;
  uid:string;
  generation:string;
  observedGeneration?:string;
  latestReadyRevision?:string;
  latestCreatedRevision?:string;
  reconciling:boolean;
  terminalCondition?:{
    state?:string;
    reason?:string;
  };
  etag?:string;
}

export interface CertifiedGcpCloudRunServiceEvidence {
  provider:'gcp';
  product:'cloud-run';
  authority_host:'run.googleapis.com';
  api_version:'v2';
  operation_id:'run.projects.locations.services.get';
  schema_sha256:string;
  observer:{kind:'gcp-rest';id:'cloud-run-service'};
  observed_at:string;
  requested_name:string;
  uid:string;
  validated_paths:string[];
  optional_absent_paths:string[];
  reconciliation:
    |'in-progress'
    |'converged'
    |'settled-not-converged';
  negative_evidence_authoritative:false;
}

export type CertifiedGcpCloudRunServiceResult=
  | {
      state:'observed';
      value:CertifiedGcpCloudRunService;
      evidence:CertifiedGcpCloudRunServiceEvidence;
    }
  | {
      state:'indeterminate';
      observation_error:string;
    };

function segment(value:string,label:string):string {
  if (
    value.length===0
    || value==='.'
    || value==='..'
    || /[\\/?#\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`GCP_CLOUD_RUN_${label}_INVALID`);
  }
  return encodeURIComponent(value);
}

function validatedCoordinate(
  coordinate:GcpCloudRunServiceCoordinate,
):GcpCloudRunServiceCoordinate {
  segment(coordinate.project,'PROJECT');
  segment(coordinate.location,'LOCATION');
  segment(coordinate.service,'SERVICE');
  return coordinate;
}

export function gcpCloudRunServiceName(
  coordinate:GcpCloudRunServiceCoordinate,
):string {
  const value=validatedCoordinate(coordinate);
  return `projects/${value.project}/locations/${value.location}/services/${value.service}`;
}

function gcpCloudRunServicePath(
  coordinate:GcpCloudRunServiceCoordinate,
):string {
  return `/v2/projects/${segment(coordinate.project,'PROJECT')}/locations/${segment(coordinate.location,'LOCATION')}/services/${segment(coordinate.service,'SERVICE')}`;
}

function reconciliationState(
  service:CertifiedGcpCloudRunService,
):CertifiedGcpCloudRunServiceEvidence['reconciliation'] {
  if (service.reconciling) return 'in-progress';
  if (
    service.observedGeneration!==undefined
    && service.latestReadyRevision!==undefined
    && service.latestCreatedRevision!==undefined
    && service.observedGeneration===service.generation
    && service.latestReadyRevision===service.latestCreatedRevision
  ) return 'converged';
  return 'settled-not-converged';
}

export function observeCertifiedGcpCloudRunService(
  accessToken:string,
  coordinate:GcpCloudRunServiceCoordinate,
  {
    get,
    clock,
    quotaProject,
  }:{
    get?:GcpJsonGet;
    clock?:()=>string;
    quotaProject?:string;
  }={},
):CertifiedGcpCloudRunServiceResult {
  try {
    const requestedName=gcpCloudRunServiceName(coordinate);
    const {observed_at:observedAt,certified}=observeCertifiedGcpRead200({
      accessToken,
      operation:GCP_CLOUD_RUN_SERVICE_OPERATION,
      request:{
        path:gcpCloudRunServicePath(coordinate),
        parameters:{name:requestedName},
      },
      fields:GCP_CLOUD_RUN_SERVICE_RESPONSE_SLICE,
      observerId:'cloud-run-service',
      ...(get?{get}:{}),
      ...(clock?{clock}:{}),
      ...(quotaProject?{quotaProject}:{}),
    });
    const value=projectResponseSlice(
      certified.outcome.value,
      GCP_CLOUD_RUN_SERVICE_RESPONSE_SLICE,
    ) as CertifiedGcpCloudRunService;

    if (value.name!==requestedName) {
      throw new Error('GCP_CLOUD_RUN_SERVICE_COORDINATE_MISMATCH');
    }
    if (value.uid.length===0) {
      throw new Error('GCP_CLOUD_RUN_SERVICE_UID_INVALID');
    }
    if (value.generation.length===0) {
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

    return {
      state:'observed',
      value,
      evidence:{
        provider:'gcp',
        product:'cloud-run',
        authority_host:'run.googleapis.com',
        api_version:'v2',
        operation_id:'run.projects.locations.services.get',
        schema_sha256:GCP_CLOUD_RUN_SERVICE_SCHEMA_SHA256,
        observer:{kind:'gcp-rest',id:'cloud-run-service'},
        observed_at:observedAt,
        requested_name:requestedName,
        uid:value.uid,
        validated_paths:certified.structural_validation.validated_paths,
        optional_absent_paths:certified.structural_validation.optional_absent_paths,
        reconciliation:reconciliationState(value),
        negative_evidence_authoritative:false,
      },
    };
  } catch (error:unknown) {
    return {
      state:'indeterminate',
      observation_error:error instanceof Error?error.message:String(error),
    };
  }
}
