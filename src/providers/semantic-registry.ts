import { createSemanticEffectRegistry } from '../semantic-command.ts';
import { githubCommitStatus } from './github/status-resource.ts';
import { kubernetesConfigMap } from './kubernetes/configmap-resource.ts';

export const semanticEffects = createSemanticEffectRegistry([
  githubCommitStatus,
  kubernetesConfigMap,
]);
