import { hostileMutationEvidenceGraphProducer } from '../evidence/hostile-mutation-obligation.ts';
import { tcbObligationsGraphProducer } from './tcb-obligations.ts';
import { compileProjectIntent, PROJECT_INTENT_PATH } from './project-intent.ts';
import type { RepositorySnapshot } from '../evidence/repository-snapshot.ts';
import type { ProjectGraphProducer } from './project-graph.ts';

export const projectIntentGraphProducer: ProjectGraphProducer = Object.freeze({
  id: 'project-intent',
  input_paths: [PROJECT_INTENT_PATH],
  produce(snapshot: RepositorySnapshot) {
    let value: unknown;
    try {
      value = JSON.parse(snapshot.bytes(PROJECT_INTENT_PATH).toString('utf8'));
    } catch {
      throw new Error('PROJECT_INTENT_JSON_INVALID');
    }
    return compileProjectIntent(value);
  },
});

export const DEFAULT_PROJECT_GRAPH_PRODUCERS = Object.freeze([
  projectIntentGraphProducer,
  hostileMutationEvidenceGraphProducer,
  tcbObligationsGraphProducer,
]);
