import type { Obligation } from '../model.ts';
import type { RepositorySnapshot } from '../evidence/repository-snapshot.ts';

export interface ProjectGraphContext {
  repository_id: number;
  repository_full_name: string;
}

export interface ProjectGraphProducer {
  readonly id: string;
  readonly input_paths: readonly string[];
  produce(snapshot: RepositorySnapshot, context: ProjectGraphContext): Obligation[];
}

export function compileProjectGraph(
  snapshot: RepositorySnapshot,
  context: ProjectGraphContext,
  producers: readonly ProjectGraphProducer[],
): Obligation[] {
  const desired: Obligation[] = [];

  for (const producer of producers) {
    const presence = producer.input_paths.map((path) => snapshot.optionalBytes(path) !== null);
    if (presence.every((present) => !present)) continue;
    if (presence.some((present) => !present)) {
      throw new Error(`PROJECT_GRAPH_PRODUCER_INPUT_INCOMPLETE:${producer.id}`);
    }
    desired.push(...producer.produce(snapshot, context));
  }

  return desired;
}
