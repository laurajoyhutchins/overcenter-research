import type { ProviderObservation } from '../provider-observation/observation.ts';
import {
  validateObservationSlice,
  type ResponseFieldSpec,
  type SchemaResolver,
  type StructuralOperation,
} from '../provider-observation/response-slice.ts';
import { asData as data } from '../validation.ts';

export const KUBERNETES_DEPLOYMENT_GET_OPERATION_ID=
  'readAppsV1NamespacedDeployment' as const;

export interface KubernetesDeploymentExpectation {
  authority_id:string;
  namespace:string;
  name:string;
  container_name:string;
  image:string;
  obligation_key:string;
  effect_identity:string;
}

export interface KubernetesDeploymentGetRequest {
  authority_id:string;
  namespace:string;
  name:string;
}

export type KubernetesDeploymentGetObservation = ProviderObservation<
  'kubernetes',
  {namespace:string;name:string;path?:string},
  Record<string,unknown>
> & {
  authority_id:string;
};

export interface KubernetesDeploymentGetRead {
  operation:StructuralOperation;
  observation:KubernetesDeploymentGetObservation;
  resolve_ref?:SchemaResolver;
}

export type KubernetesDeploymentVerification =
  | {
      state:'verified';
      reason:'EXACT_HEALTHY_REALIZATION';
      uid:string;
      resource_version:string;
      provider_evidence:Record<string,unknown>;
    }
  | {
      state:'rejected'|'indeterminate';
      reason:string;
      provider_evidence:Record<string,unknown>;
    };

export const KUBERNETES_DEPLOYMENT_RESPONSE_SLICE=[
  {path:'apiVersion'},
  {path:'kind'},
  {path:'metadata.name'},
  {path:'metadata.namespace'},
  {path:'metadata.uid'},
  {path:'metadata.resourceVersion'},
  {path:'metadata.generation'},
  {path:'metadata.annotations'},
  {path:'spec.replicas'},
  {path:'spec.template.spec.containers[].name'},
  {path:'spec.template.spec.containers[].image'},
  {path:'status.observedGeneration'},
  {path:'status.availableReplicas'},
] as const satisfies readonly ResponseFieldSpec[];

function evidence(
  expectation:KubernetesDeploymentExpectation,
  structural:unknown=null,
):Record<string,unknown> {
  return {
    provider:'kubernetes',
    authority_id:expectation.authority_id,
    namespace:expectation.namespace,
    name:expectation.name,
    ...(structural?{structural_validation:structural}:{}),
  };
}

export function verifyCertifiedKubernetesDeployment(
  expectation:KubernetesDeploymentExpectation,
  read:KubernetesDeploymentGetRead,
):KubernetesDeploymentVerification {
  try {
    const {operation,observation,resolve_ref:resolveRef}=read;
    if (
      operation.operation_id!==KUBERNETES_DEPLOYMENT_GET_OPERATION_ID
      || observation.contract.provider!=='kubernetes'
      || observation.contract.operation_id!==KUBERNETES_DEPLOYMENT_GET_OPERATION_ID
      || observation.authority_id!==expectation.authority_id
      || observation.request.namespace!==expectation.namespace
      || observation.request.name!==expectation.name
    ) {
      return {
        state:'indeterminate',
        reason:'KUBERNETES_DEPLOYMENT_OBSERVATION_COORDINATE_MISMATCH',
        provider_evidence:evidence(expectation),
      };
    }
    if (
      observation.outcome.status!==200
      || observation.outcome.visibility!=='observed'
    ) {
      return {
        state:'indeterminate',
        reason:'KUBERNETES_DEPLOYMENT_NOT_AUTHORITATIVE',
        provider_evidence:evidence(expectation),
      };
    }

    const certified=validateObservationSlice(
      operation,
      observation,
      KUBERNETES_DEPLOYMENT_RESPONSE_SLICE,
      resolveRef,
      {
        requiredTopLevelExtensions:{
          authority_id:'non-empty-string',
        },
      },
    );
    const body=data(certified.outcome.value);
    const metadata=data(body?.metadata);
    const spec=data(body?.spec);
    const template=data(spec?.template);
    const templateSpec=data(template?.spec);
    const status=data(body?.status);
    const annotations=data(metadata?.annotations);
    const containers=Array.isArray(templateSpec?.containers)
      ? templateSpec.containers.map(data)
      : [];
    const container=containers.find(
      candidate=>candidate?.name===expectation.container_name,
    );

    if (
      body?.apiVersion!=='apps/v1'
      || body?.kind!=='Deployment'
      || metadata?.namespace!==expectation.namespace
      || metadata?.name!==expectation.name
      || typeof metadata.uid!=='string'
      || metadata.uid.length===0
      || typeof metadata.resourceVersion!=='string'
      || metadata.resourceVersion.length===0
      || !Number.isSafeInteger(metadata.generation)
      || !Number.isSafeInteger(status?.observedGeneration)
      || !Number.isSafeInteger(spec?.replicas)
      || !Number.isSafeInteger(status?.availableReplicas)
      || !container
      || typeof container.image!=='string'
    ) {
      return {
        state:'indeterminate',
        reason:'KUBERNETES_DEPLOYMENT_SEMANTICS_INVALID',
        provider_evidence:evidence(expectation,certified.structural_validation),
      };
    }

    const providerEvidence=evidence(
      expectation,
      certified.structural_validation,
    );
    if (container.image!==expectation.image) {
      return {
        state:'rejected',
        reason:'KUBERNETES_DEPLOYMENT_IMAGE_MISMATCH',
        provider_evidence:providerEvidence,
      };
    }
    if (
      annotations?.['overcenter.dev/obligation-key']!==expectation.obligation_key
      || annotations?.['overcenter.dev/effect-identity']!==expectation.effect_identity
    ) {
      return {
        state:'rejected',
        reason:'KUBERNETES_DEPLOYMENT_REALIZATION_IDENTITY_MISMATCH',
        provider_evidence:providerEvidence,
      };
    }
    if (
      status.observedGeneration!==metadata.generation
      || (spec.replicas as number)<=0
      || status.availableReplicas!==spec.replicas
    ) {
      return {
        state:'rejected',
        reason:'KUBERNETES_DEPLOYMENT_NOT_HEALTHY_CURRENT_GENERATION',
        provider_evidence:providerEvidence,
      };
    }

    return {
      state:'verified',
      reason:'EXACT_HEALTHY_REALIZATION',
      uid:metadata.uid,
      resource_version:metadata.resourceVersion,
      provider_evidence:providerEvidence,
    };
  } catch (error:unknown) {
    return {
      state:'indeterminate',
      reason:error instanceof Error?error.message:String(error),
      provider_evidence:evidence(expectation),
    };
  }
}
