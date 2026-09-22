import { canonicalDigest } from '../digest.ts';
import { projectResponseSlice } from '../provider-observation/response-slice.ts';
import {
  observeCertifiedGcpRead200,
  type GcpObservationOperation,
} from './gcp-certified-observation.ts';
import type { GcpJsonGet } from './gcp-rest.ts';

const CLOUD_SQL_INSTANCE_SCHEMA={
  type:'object',
  properties:{
    kind:{type:'string'},
    state:{type:'string'},
    databaseVersion:{type:'string'},
    settings:{
      type:'object',
      properties:{
        settingsVersion:{type:'string'},
      },
    },
    project:{type:'string'},
    backendType:{type:'string'},
    selfLink:{type:'string'},
    connectionName:{type:'string'},
    name:{type:'string'},
    region:{type:'string'},
    gceZone:{type:'string'},
  },
} as const;

export const GCP_CLOUD_SQL_INSTANCE_SCHEMA_SHA256=
  canonicalDigest(CLOUD_SQL_INSTANCE_SCHEMA);

export const GCP_CLOUD_SQL_INSTANCE_OPERATION:GcpObservationOperation={
  provider:'gcp',
  authority_host:'sqladmin.googleapis.com',
  api_version:'v1beta4',
  method:'GET',
  path_template:'/sql/v1beta4/projects/{project}/instances/{instance}',
  operation_id:'sql.instances.get',
  schema_sha256:GCP_CLOUD_SQL_INSTANCE_SCHEMA_SHA256,
  outcomes:[{status:'200',schema:CLOUD_SQL_INSTANCE_SCHEMA}],
};

export const GCP_CLOUD_SQL_INSTANCE_RESPONSE_SLICE=[
  {path:'kind'},
  {path:'state'},
  {path:'databaseVersion'},
  {path:'settings.settingsVersion'},
  {path:'project'},
  {path:'backendType'},
  {path:'selfLink'},
  {path:'connectionName'},
  {path:'name'},
  {path:'region'},
  {path:'gceZone',required:false},
] as const;

export interface GcpCloudSqlInstanceCoordinate {
  project:string;
  instance:string;
}

export interface CertifiedGcpCloudSqlInstance {
  kind:string;
  state:string;
  databaseVersion:string;
  settings:{settingsVersion:string};
  project:string;
  backendType:string;
  selfLink:string;
  connectionName:string;
  name:string;
  region:string;
  gceZone?:string;
}

export interface CertifiedGcpCloudSqlInstanceEvidence {
  provider:'gcp';
  product:'cloud-sql';
  authority_host:'sqladmin.googleapis.com';
  api_version:'v1beta4';
  operation_id:'sql.instances.get';
  schema_sha256:string;
  observer:{kind:'gcp-rest';id:'cloud-sql-instance'};
  observed_at:string;
  project:string;
  instance:string;
  settings_version:string;
  validated_paths:string[];
  optional_absent_paths:string[];
  negative_evidence_authoritative:false;
}

export type CertifiedGcpCloudSqlInstanceResult=
  | {
      state:'observed';
      value:CertifiedGcpCloudSqlInstance;
      evidence:CertifiedGcpCloudSqlInstanceEvidence;
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
    throw new Error(`GCP_CLOUD_SQL_${label}_INVALID`);
  }
  return encodeURIComponent(value);
}

function cloudSqlPath(
  coordinate:GcpCloudSqlInstanceCoordinate,
):string {
  return `/sql/v1beta4/projects/${segment(coordinate.project,'PROJECT')}/instances/${segment(coordinate.instance,'INSTANCE')}`;
}

export function observeCertifiedGcpCloudSqlInstance(
  accessToken:string,
  coordinate:GcpCloudSqlInstanceCoordinate,
  {
    get,
    clock,
    quotaProject,
  }:{
    get?:GcpJsonGet;
    clock?:()=>string;
    quotaProject?:string;
  }={},
):CertifiedGcpCloudSqlInstanceResult {
  try {
    const {observed_at:observedAt,certified}=observeCertifiedGcpRead200({
      accessToken,
      operation:GCP_CLOUD_SQL_INSTANCE_OPERATION,
      request:{
        path:cloudSqlPath(coordinate),
        parameters:{
          project:coordinate.project,
          instance:coordinate.instance,
        },
      },
      fields:GCP_CLOUD_SQL_INSTANCE_RESPONSE_SLICE,
      observerId:'cloud-sql-instance',
      ...(get?{get}:{}),
      ...(clock?{clock}:{}),
      ...(quotaProject?{quotaProject}:{}),
    });
    const value=projectResponseSlice(
      certified.outcome.value,
      GCP_CLOUD_SQL_INSTANCE_RESPONSE_SLICE,
    ) as CertifiedGcpCloudSqlInstance;

    if (
      value.kind!=='sql#instance'
      || value.project!==coordinate.project
      || value.name!==coordinate.instance
    ) {
      throw new Error('GCP_CLOUD_SQL_INSTANCE_COORDINATE_MISMATCH');
    }
    if (value.settings.settingsVersion.length===0) {
      throw new Error('GCP_CLOUD_SQL_SETTINGS_VERSION_INVALID');
    }
    if (
      value.state.length===0
      || value.databaseVersion.length===0
      || value.backendType.length===0
      || value.selfLink.length===0
      || value.connectionName.length===0
      || value.region.length===0
    ) {
      throw new Error('GCP_CLOUD_SQL_INSTANCE_STATE_INVALID');
    }

    return {
      state:'observed',
      value,
      evidence:{
        provider:'gcp',
        product:'cloud-sql',
        authority_host:'sqladmin.googleapis.com',
        api_version:'v1beta4',
        operation_id:'sql.instances.get',
        schema_sha256:GCP_CLOUD_SQL_INSTANCE_SCHEMA_SHA256,
        observer:{kind:'gcp-rest',id:'cloud-sql-instance'},
        observed_at:observedAt,
        project:coordinate.project,
        instance:coordinate.instance,
        settings_version:value.settings.settingsVersion,
        validated_paths:certified.structural_validation.validated_paths,
        optional_absent_paths:certified.structural_validation.optional_absent_paths,
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
