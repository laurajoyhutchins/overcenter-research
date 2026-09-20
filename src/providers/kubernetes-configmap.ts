import { canonicalDigest } from '../digest.ts';
import {
  ABSENCE_EVIDENCE_SCHEMA,
  validateAbsenceEvidenceEnvelope,
} from '../evidence.ts';
import type {
  AbsenceEvidenceCertificate,
  KubernetesConfigMapExistsPostcondition,
} from '../model.ts';
import type { ProviderObservation } from '../provider-observation/observation.ts';
import { asData as data, hasExactKeys as exactKeys } from '../validation.ts';
import {
  validateObservationSlice,
  type ResponseFieldSpec,
  type SchemaResolver,
  type StructuralOperation,
} from '../provider-observation/response-slice.ts';

export const KUBERNETES_CONFIGMAP_LIST_OPERATION_ID='listCoreV1NamespacedConfigMap' as const;
export const KUBERNETES_COMPLETE_LIST_ABSENCE='kubernetes-complete-list-absence/v1' as const;

export interface KubernetesConfigMapListRequest {
  authority_id:string;
  namespace:string;
  continue_token:string|null;
  limit:number;
}

export interface KubernetesConfigMapListObservationRequest {
  namespace:string;
  continue_token:string|null;
  limit:number;
  path?:string;
}

export type KubernetesConfigMapListObservation = ProviderObservation<
  'kubernetes',
  KubernetesConfigMapListObservationRequest,
  Record<string,unknown>
> & {
  authority_id:string;
};

export interface KubernetesConfigMapListRead {
  operation:StructuralOperation;
  observation:KubernetesConfigMapListObservation;
  resolve_ref?:SchemaResolver;
}

export type KubernetesListConfigMaps = (
  request:KubernetesConfigMapListRequest,
)=>KubernetesConfigMapListRead;

export interface KubernetesConfigMapVerification {
  state:'present'|'absent'|'indeterminate';
  reason:string;
  uid?:string;
  resource_version?:string;
  snapshot_resource_version?:string;
  absence_evidence?:AbsenceEvidenceCertificate;
  provider_evidence:Record<string,unknown>;
}

export interface KubernetesWatchContinuity {
  authority_id:string;
  namespace:string;
  start_resource_version:string;
  last_resource_version:string;
  continuity:'maintained'|'broken-relist-required';
  termination:'client-stop'|'eof'|'timeout'|'gone'|'error';
  target_events:Array<'ADDED'|'MODIFIED'|'DELETED'>;
}

export const KUBERNETES_CONFIGMAP_LIST_RESPONSE_SLICE=[
  {path:'apiVersion'},
  {path:'kind'},
  {path:'metadata.resourceVersion'},
  {path:'metadata.continue',required:false},
  {path:'items[].metadata.name'},
  {path:'items[].metadata.namespace'},
  {path:'items[].metadata.uid'},
  {path:'items[].metadata.resourceVersion'},
] as const satisfies readonly ResponseFieldSpec[];

function stringArray(value:unknown):value is string[] {
  return Array.isArray(value) && value.every(member=>typeof member==='string');
}

function sha256Digest(value:unknown):string {
  return `sha256:${canonicalDigest(value)}`;
}

function matchesSha256(value:unknown):value is string {
  return typeof value==='string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function absenceCoordinates(
  postcondition:KubernetesConfigMapExistsPostcondition,
) {
  const scope={
    provider:'kubernetes',
    authority_id:postcondition.authority_id,
    api_group:'',
    resource:'configmaps',
    namespace:postcondition.namespace,
  };
  return {scope,subject:{...scope,name:postcondition.name}};
}

function listPageEvidenceMatches(
  value:unknown,
  index:number,
  snapshotResourceVersion:string,
  previousResponseContinue:string|null,
  terminal:boolean,
):boolean {
  const page=data(value);
  if (!page || !exactKeys(page,[
    'page','request_continue','response_continue','snapshot_resource_version',
    'schema_sha256','validated_paths','optional_absent_paths',
  ])) return false;
  if (
    page.page!==index+1
    || page.request_continue!==(index===0?null:previousResponseContinue)
    || typeof page.response_continue!=='string'
    || page.snapshot_resource_version!==snapshotResourceVersion
    || typeof page.schema_sha256!=='string'
    || !/^[0-9a-f]{64}$/.test(page.schema_sha256)
    || !stringArray(page.validated_paths)
    || !stringArray(page.optional_absent_paths)
  ) return false;
  return terminal?page.response_continue==='':page.response_continue.length>0;
}

function providerEvidence(
  postcondition:KubernetesConfigMapExistsPostcondition,
  pages:Record<string,unknown>[],
  terminalStatus?:number,
):Record<string,unknown> {
  return {
    provider:'kubernetes',
    authority_id:postcondition.authority_id,
    pages,
    ...(terminalStatus===undefined?{}:{terminal_status:terminalStatus}),
  };
}

function completeListAbsenceEvidence(
  postcondition:KubernetesConfigMapExistsPostcondition,
  pages:Record<string,unknown>[],
  snapshotResourceVersion:string,
):AbsenceEvidenceCertificate {
  return {
    schema:ABSENCE_EVIDENCE_SCHEMA,
    kind:KUBERNETES_COMPLETE_LIST_ABSENCE,
    ...absenceCoordinates(postcondition),
    snapshot:{resource_version:snapshotResourceVersion},
    completeness:{
      kind:'complete-list',
      page_count:pages.length,
      terminal_continue:'',
      page_chain_digest:sha256Digest(pages),
    },
    provenance:{
      provider:'kubernetes',
      authority_id:postcondition.authority_id,
      operation_id:KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
      pages,
    },
  };
}

export function kubernetesConfigMapAbsenceEvidenceMatches(
  value:unknown,
  postcondition:KubernetesConfigMapExistsPostcondition,
):value is AbsenceEvidenceCertificate {
  try {
    validateAbsenceEvidenceEnvelope(value);
  } catch {
    return false;
  }
  if (value.kind!==KUBERNETES_COMPLETE_LIST_ABSENCE) return false;
  const coordinates=absenceCoordinates(postcondition);
  if (
    canonicalDigest(value.subject)!==canonicalDigest(coordinates.subject)
    || canonicalDigest(value.scope)!==canonicalDigest(coordinates.scope)
  ) return false;

  const snapshot=data(value.snapshot);
  const completeness=value.completeness;
  const provenance=value.provenance;
  if (
    !snapshot
    || !exactKeys(snapshot,['resource_version'])
    || typeof snapshot.resource_version!=='string'
    || snapshot.resource_version.length===0
    || !exactKeys(provenance,['provider','authority_id','operation_id','pages'])
    || provenance.provider!=='kubernetes'
    || provenance.authority_id!==postcondition.authority_id
    || provenance.operation_id!==KUBERNETES_CONFIGMAP_LIST_OPERATION_ID
    || !Array.isArray(provenance.pages)
    || provenance.pages.length===0
  ) return false;

  if (completeness.kind==='complete-list') {
    if (!exactKeys(completeness,[
      'kind','page_count','terminal_continue','page_chain_digest',
    ])) return false;
  } else if (completeness.kind==='complete-list-plus-watch') {
    if (
      !exactKeys(completeness,[
        'kind','page_count','terminal_continue','page_chain_digest',
        'watch_start_resource_version','watch_last_resource_version',
        'watch_continuity','watch_termination','watch_events_digest',
      ])
      || completeness.watch_continuity!=='maintained'
      || !['client-stop','eof','timeout'].includes(String(completeness.watch_termination))
      || !matchesSha256(completeness.watch_events_digest)
    ) return false;
  } else {
    return false;
  }

  const pageCount=completeness.page_count;
  if (
    completeness.terminal_continue!==''
    || !Number.isSafeInteger(pageCount)
    || (pageCount as number)<=0
    || provenance.pages.length!==pageCount
    || !matchesSha256(completeness.page_chain_digest)
    || completeness.page_chain_digest!==sha256Digest(provenance.pages)
  ) return false;

  const pageSnapshotResourceVersion=completeness.kind==='complete-list-plus-watch'
    ? completeness.watch_start_resource_version
    : snapshot.resource_version;
  if (typeof pageSnapshotResourceVersion!=='string') return false;

  for (let index=0;index<provenance.pages.length;index+=1) {
    const previous=index===0
      ? null
      : data(provenance.pages[index-1])?.response_continue;
    if (
      (previous!==null && typeof previous!=='string')
      || !listPageEvidenceMatches(
        provenance.pages[index],
        index,
        pageSnapshotResourceVersion,
        previous,
        index===provenance.pages.length-1,
      )
    ) return false;
  }

  if (completeness.kind==='complete-list') return true;
  return typeof completeness.watch_start_resource_version==='string'
    && typeof completeness.watch_last_resource_version==='string'
    && completeness.watch_last_resource_version===snapshot.resource_version;
}

export function carryKubernetesAbsenceThroughWatch(
  postcondition:KubernetesConfigMapExistsPostcondition,
  base:AbsenceEvidenceCertificate,
  watch:KubernetesWatchContinuity,
):AbsenceEvidenceCertificate|null {
  if (!kubernetesConfigMapAbsenceEvidenceMatches(base,postcondition)) return null;
  if (base.completeness.kind!=='complete-list') return null;
  if (
    watch.authority_id!==postcondition.authority_id
    || watch.namespace!==postcondition.namespace
    || watch.continuity!=='maintained'
    || watch.start_resource_version!==base.snapshot?.resource_version
    || watch.termination==='gone'
    || watch.termination==='error'
  ) return null;

  let absent=true;
  for (const event of watch.target_events) {
    if (event==='ADDED' || event==='MODIFIED') absent=false;
    if (event==='DELETED') absent=true;
  }
  if (!absent) return null;

  return {
    ...base,
    snapshot:{resource_version:watch.last_resource_version},
    completeness:{
      ...base.completeness,
      kind:'complete-list-plus-watch',
      watch_start_resource_version:watch.start_resource_version,
      watch_last_resource_version:watch.last_resource_version,
      watch_continuity:'maintained',
      watch_termination:watch.termination,
      watch_events_digest:sha256Digest(watch.target_events),
    },
  };
}

export function observeCertifiedKubernetesConfigMap(
  postcondition:KubernetesConfigMapExistsPostcondition,
  {
    list,
    limit=100,
  }:{
    list:KubernetesListConfigMaps;
    limit?:number;
  },
):KubernetesConfigMapVerification {
  const pages:Record<string,unknown>[]=[];
  const indeterminate=(
    reason:string,
    terminalStatus?:number,
  ):KubernetesConfigMapVerification=>({
    state:'indeterminate',
    reason,
    provider_evidence:providerEvidence(postcondition,pages,terminalStatus),
  });
  let continueToken:string|null=null;
  let snapshotResourceVersion:string|null=null;

  try {
    for (let pageNumber=1;pageNumber<=1000;pageNumber+=1) {
      const read=list({
        authority_id:postcondition.authority_id,
        namespace:postcondition.namespace,
        continue_token:continueToken,
        limit,
      });
      const {operation,observation,resolve_ref:resolveRef}=read;

      if (
        operation.operation_id!==KUBERNETES_CONFIGMAP_LIST_OPERATION_ID
        || observation.contract.provider!=='kubernetes'
        || observation.contract.operation_id!==KUBERNETES_CONFIGMAP_LIST_OPERATION_ID
        || observation.authority_id!==postcondition.authority_id
        || observation.request.namespace!==postcondition.namespace
        || observation.request.continue_token!==continueToken
        || observation.request.limit!==limit
      ) {
        throw new Error('KUBERNETES_LIST_OBSERVATION_COORDINATE_MISMATCH');
      }

      if (
        observation.outcome.status!==200
        || observation.outcome.visibility!=='observed'
      ) {
        return indeterminate(
          observation.outcome.status===410
            ? 'KUBERNETES_CONTINUATION_EXPIRED'
            : 'KUBERNETES_LIST_NOT_AUTHORITATIVE',
          observation.outcome.status,
        );
      }

      const certified=validateObservationSlice(
        operation,
        observation,
        KUBERNETES_CONFIGMAP_LIST_RESPONSE_SLICE,
        resolveRef,
        {
          requiredTopLevelExtensions:{
            authority_id:'non-empty-string',
          },
        },
      );
      const body=data(certified.outcome.value);
      const metadata=data(body?.metadata);
      if (
        body?.apiVersion!=='v1'
        || body?.kind!=='ConfigMapList'
        || !metadata
        || !Array.isArray(body.items)
        || typeof metadata.resourceVersion!=='string'
        || metadata.resourceVersion.length===0
        || (
          metadata.continue!==undefined
          && typeof metadata.continue!=='string'
        )
      ) {
        throw new Error('KUBERNETES_LIST_SEMANTICS_INVALID');
      }

      const structural=certified.structural_validation;
      const continueCertified=structural.validated_paths.includes('metadata.continue')
        || structural.optional_absent_paths.includes('metadata.continue');
      if (!continueCertified) {
        throw new Error('KUBERNETES_LIST_CONTINUE_NOT_CERTIFIED');
      }

      if (snapshotResourceVersion===null) {
        snapshotResourceVersion=metadata.resourceVersion;
      } else if (snapshotResourceVersion!==metadata.resourceVersion) {
        throw new Error('KUBERNETES_LIST_RESOURCE_VERSION_CHANGED');
      }

      const nextContinue=metadata.continue ?? '';
      const pageEvidence={
        page:pageNumber,
        request_continue:continueToken,
        response_continue:nextContinue,
        snapshot_resource_version:metadata.resourceVersion,
        schema_sha256:certified.contract.schema_sha256,
        validated_paths:structural.validated_paths,
        optional_absent_paths:structural.optional_absent_paths,
      };
      pages.push(pageEvidence);

      for (const item of body.items) {
        const object=data(item);
        const itemMetadata=data(object?.metadata);
        if (
          !itemMetadata
          || typeof itemMetadata.name!=='string'
          || typeof itemMetadata.namespace!=='string'
          || typeof itemMetadata.uid!=='string'
          || typeof itemMetadata.resourceVersion!=='string'
          || itemMetadata.namespace!==postcondition.namespace
        ) {
          throw new Error('KUBERNETES_LIST_MEMBER_INVALID');
        }
        if (itemMetadata.name===postcondition.name) {
          return {
            state:'present',
            reason:'AUTHORITATIVE_COLLECTION_MEMBER_PRESENT',
            uid:itemMetadata.uid,
            resource_version:itemMetadata.resourceVersion,
            snapshot_resource_version:metadata.resourceVersion,
            provider_evidence:providerEvidence(postcondition,pages),
          };
        }
      }

      if (nextContinue==='') {
        const absenceEvidence=completeListAbsenceEvidence(
          postcondition,
          pages,
          snapshotResourceVersion!,
        );
        if (!kubernetesConfigMapAbsenceEvidenceMatches(absenceEvidence,postcondition)) {
          throw new Error('KUBERNETES_ABSENCE_CERTIFICATE_SELF_CHECK_FAILED');
        }
        return {
          state:'absent',
          reason:'AUTHORITATIVE_COMPLETE_LIST_ABSENCE',
          snapshot_resource_version:snapshotResourceVersion!,
          absence_evidence:absenceEvidence,
          provider_evidence:providerEvidence(postcondition,pages),
        };
      }

      if (nextContinue===continueToken) {
        throw new Error('KUBERNETES_LIST_CONTINUATION_DID_NOT_ADVANCE');
      }
      continueToken=nextContinue;
    }
  } catch (error:unknown) {
    return indeterminate(error instanceof Error?error.message:String(error));
  }

  return indeterminate('KUBERNETES_LIST_PAGINATION_EXHAUSTED');
}
