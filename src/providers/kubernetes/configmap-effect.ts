import type { EffectAuthority, KernelCore } from '../../authority/engine.ts';
import { KUBERNETES_CONFIGMAP_EFFECT } from '../../effect-adapter.ts';

export { KUBERNETES_CONFIGMAP_EFFECT } from '../../effect-adapter.ts';

export interface KubernetesConfigMapApplyRequest {
  authority_id: string;
  method: 'PATCH';
  path: string;
  content_type: 'application/apply-patch+yaml';
  field_manager: 'overcenter';
  body: {
    apiVersion: 'v1';
    kind: 'ConfigMap';
    metadata: {
      namespace: string;
      name: string;
    };
  };
}

export interface KubernetesConfigMapApplyResponse {
  status: number;
  body: string;
}

export type KubernetesConfigMapApply = (
  request: KubernetesConfigMapApplyRequest,
) => Promise<KubernetesConfigMapApplyResponse>;

export async function performKubernetesConfigMapEffect(
  kernel: KernelCore,
  authority: EffectAuthority<typeof KUBERNETES_CONFIGMAP_EFFECT, 'kubernetes-configmap-exists/v1'>,
  { apply }: { apply: KubernetesConfigMapApply },
): Promise<{
  authority_id: string;
  namespace: string;
  name: string;
}> {
  const p = authority.postcondition;
  const path =
    `/api/v1/namespaces/${encodeURIComponent(p.namespace)}` +
    `/configmaps/${encodeURIComponent(p.name)}?fieldManager=overcenter`;

  return await kernel.performEffect(authority, async () => {
    const response = await apply({
      authority_id: p.authority_id,
      method: 'PATCH',
      path,
      content_type: 'application/apply-patch+yaml',
      field_manager: 'overcenter',
      body: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          namespace: p.namespace,
          name: p.name,
        },
      },
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`KUBERNETES_CONFIGMAP_MUTATION_FAILED:${response.status}:${response.body}`);
    }
    return {
      authority_id: p.authority_id,
      namespace: p.namespace,
      name: p.name,
    };
  });
}
