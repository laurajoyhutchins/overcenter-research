import {
  KUBERNETES_DEPLOYMENT_GET_OPERATION_ID,
  KUBERNETES_DEPLOYMENT_RESPONSE_SLICE,
  verifyCertifiedKubernetesDeployment,
} from '../../src/providers/kubernetes-deployment.ts';
import { validateObservationSlice } from '../../src/provider-observation/response-slice.ts';
import { asData as data } from '../../src/validation.ts';

// measure:conventional:start
export function conventionalSafeAccepts(expectation,read) {
  const {operation,observation,resolve_ref:resolveRef}=read;
  // recovery-branch
  if (
    operation.operation_id!==KUBERNETES_DEPLOYMENT_GET_OPERATION_ID
    || observation.contract.provider!=='kubernetes'
    || observation.contract.operation_id!==KUBERNETES_DEPLOYMENT_GET_OPERATION_ID
    // identity-join
    || observation.authority_id!==expectation.authority_id
    // identity-join
    || observation.request.namespace!==expectation.namespace
    // identity-join
    || observation.request.name!==expectation.name
    || observation.outcome.status!==200
    || observation.outcome.visibility!=='observed'
  ) return false;

  let certified;
  try {
    certified=validateObservationSlice(
      operation,
      observation,
      KUBERNETES_DEPLOYMENT_RESPONSE_SLICE,
      resolveRef,
      {requiredTopLevelExtensions:{authority_id:'non-empty-string'}},
    );
  } catch {
    // recovery-branch
    return false;
  }

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
  const container=containers.find(candidate=>candidate?.name===expectation.container_name);

  // recovery-branch
  if (
    body?.apiVersion!=='apps/v1'
    || body?.kind!=='Deployment'
    // identity-join
    || metadata?.namespace!==expectation.namespace
    // identity-join
    || metadata?.name!==expectation.name
    || !container
    // identity-join
    || container.image!==expectation.image
    // identity-join
    || annotations?.['overcenter.dev/obligation-key']!==expectation.obligation_key
    // identity-join
    || annotations?.['overcenter.dev/effect-identity']!==expectation.effect_identity
    || status?.observedGeneration!==metadata?.generation
    || !Number.isSafeInteger(spec?.replicas)
    || (spec.replicas??0)<=0
    || status?.availableReplicas!==spec?.replicas
  ) return false;

  return true;
}
// measure:conventional:end

// measure:overcenter:start
export function overcenterSafeAccepts(expectation,read) {
  return verifyCertifiedKubernetesDeployment(expectation,read).state==='verified';
}
// measure:overcenter:end
