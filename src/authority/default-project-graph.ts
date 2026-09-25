import { hostileMutationEvidenceGraphProducer } from '../evidence/hostile-mutation-obligation.ts';
import { repositorySnapshot } from '../evidence/repository-snapshot.ts';
import { compileProjectIntent, PROJECT_INTENT_PATH } from './project-intent.ts';
import {
  compileProjectGraph,
  type ProjectGraphContext,
  type ProjectGraphProducer,
} from './project-graph.ts';

const projectIntentGraphProducer: ProjectGraphProducer = Object.freeze({
  id: 'project-intent',
  input_paths: [PROJECT_INTENT_PATH],
  produce(snapshot) {
    let value: unknown;
    try {
      value = JSON.parse(snapshot.bytes(PROJECT_INTENT_PATH).toString('utf8'));
    } catch {
      throw new Error('PROJECT_INTENT_JSON_INVALID');
    }
    return compileProjectIntent(value);
  },
});

const DEFAULT_PROJECT_GRAPH_PRODUCERS = Object.freeze([
  projectIntentGraphProducer,
  hostileMutationEvidenceGraphProducer,
]);

export function compileDefaultProjectGraph(
  repo: string,
  sourceSha: string,
  context: ProjectGraphContext,
) {
  return compileProjectGraph(
    repositorySnapshot(repo, sourceSha),
    context,
    DEFAULT_PROJECT_GRAPH_PRODUCERS,
  );
}
