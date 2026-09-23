import {canonicalDigest} from '../../digest.ts';
import {
  gcpPathSegment,
  observeCertifiedGcpResource,
  type GcpObservationOperation,
  type GcpReadOptions,
} from './certified-observation.ts';

const CLOUD_SQL_INSTANCE_SCHEMA={
  type:'object',
  properties:{
    kind:{type:'string'},
    state:{type:'string'},
    databaseVersion:{type:'string'},
    settings:{type:'object',properties:{settingsVersion:{type:'string'}}},
    project:{type:'string'},
    backendType:{type:'string'},
    selfLink:{type:'string'},
    connectionName:{type:'string'},
    name:{type:'string'},
    region:{type:'string'},
    gceZone:{type:'string'},
  },
} as const;

export const GCP_CLOUD_SQL_INSTANCE_SCHEMA_SHA256=canonicalDigest(CLOUD_SQL_INSTANCE_SCHEMA);

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

interface CertifiedGcpCloudSqlInstance {
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

function cloudSqlPath(coordinate:GcpCloudSqlInstanceCoordinate):string {
  return `/sql/v1beta4/projects/${gcpPathSegment(coordinate.project,'GCP_CLOUD_SQL_PROJECT_INVALID')}/instances/${gcpPathSegment(coordinate.instance,'GCP_CLOUD_SQL_INSTANCE_INVALID')}`;
}

export function observeCertifiedGcpCloudSqlInstance(
  accessToken:string,
  coordinate:GcpCloudSqlInstanceCoordinate,
  options:GcpReadOptions={},
) {
  return observeCertifiedGcpResource<CertifiedGcpCloudSqlInstance>({
    accessToken,
    operation:GCP_CLOUD_SQL_INSTANCE_OPERATION,
    request:{
      path:cloudSqlPath(coordinate),
      parameters:{project:coordinate.project,instance:coordinate.instance},
    },
    fields:GCP_CLOUD_SQL_INSTANCE_RESPONSE_SLICE,
    observerId:'cloud-sql-instance',
    options,
    validate:value=>{
      if (
        value.kind!=='sql#instance'
        || value.project!==coordinate.project
        || value.name!==coordinate.instance
      ) throw new Error('GCP_CLOUD_SQL_INSTANCE_COORDINATE_MISMATCH');
      if (!value.settings.settingsVersion) {
        throw new Error('GCP_CLOUD_SQL_SETTINGS_VERSION_INVALID');
      }
      if (
        !value.state
        || !value.databaseVersion
        || !value.backendType
        || !value.selfLink
        || !value.connectionName
        || !value.region
      ) throw new Error('GCP_CLOUD_SQL_INSTANCE_STATE_INVALID');
    },
    evidence:value=>({
      product:'cloud-sql',
      project:coordinate.project,
      instance:coordinate.instance,
      settings_version:value.settings.settingsVersion,
    }),
  });
}
