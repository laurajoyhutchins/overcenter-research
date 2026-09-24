import { KUBERNETES_CONFIGMAP_EFFECT } from '../../effect-adapter.ts';
import type { Data } from '../../model.ts';
import { defineSemanticEffect } from '../../semantic-effect.ts';
import { assertExactKeys, assertNonEmptyString } from '../../validation.ts';

export type KubernetesConfigMapTarget = Data & {
  authority_id: string;
  namespace: string;
  name: string;
};

export type KubernetesConfigMapDesired = Data & {
  exists: true;
};

export const kubernetesConfigMap = defineSemanticEffect<
  typeof KUBERNETES_CONFIGMAP_EFFECT,
  KubernetesConfigMapTarget,
  KubernetesConfigMapDesired
>({
  resource: 'kubernetes.configmap',
  effectContract: KUBERNETES_CONFIGMAP_EFFECT,
  postcondition: (target, desired) => {
    assertExactKeys(
      target,
      ['authority_id', 'namespace', 'name'],
      [],
      'KUBERNETES_CONFIGMAP_TARGET_INVALID',
    );
    assertExactKeys(desired, ['exists'], [], 'KUBERNETES_CONFIGMAP_DESIRED_INVALID');
    assertNonEmptyString(target.authority_id, 'KUBERNETES_CONFIGMAP_AUTHORITY_ID_INVALID');
    assertNonEmptyString(target.namespace, 'KUBERNETES_CONFIGMAP_NAMESPACE_INVALID');
    assertNonEmptyString(target.name, 'KUBERNETES_CONFIGMAP_NAME_INVALID');
    if (desired.exists !== true) {
      throw new Error('KUBERNETES_CONFIGMAP_ENSURE_REQUIRES_EXISTS_TRUE');
    }
    return {
      provider: 'kubernetes',
      authority_id: target.authority_id,
      api_group: '',
      resource: 'configmaps',
      namespace: target.namespace,
      name: target.name,
    };
  },
});
