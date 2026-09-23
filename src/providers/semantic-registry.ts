import { createSemanticEffectRegistry } from '../semantic-command.ts';
import { githubCommitStatus } from './github/status-resource.ts';

export const semanticEffects = createSemanticEffectRegistry([githubCommitStatus]);
