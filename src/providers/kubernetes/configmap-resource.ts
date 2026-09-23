import { KUBERNETES_CONFIGMAP_EFFECT } from '../../effect-adapter.ts';
import type { Data } from '../../model.ts';
import { defineSemanticEffect } from '../../semantic-effect.ts';

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
