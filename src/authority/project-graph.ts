import type { ObligationInput } from './facts.ts';
import type { RepositorySnapshot } from '../evidence/repository-snapshot.ts';

export interface ProjectGraphContext {
  repository_id: number;
  repository_full_name: string;
}

export interface ProjectGraphProducer {
  readonly id: string;
  readonly input_paths: readonly string[];
  readonly managed_prefixes?: readonly string[];
  produce(snapshot: RepositorySnapshot, context: ProjectGraphContext): ObligationInput[];
}

function producerActive(snapshot: RepositorySnapshot, producer: ProjectGraphProducer): boolean {
  const presence = producer.input_paths.map((path) => snapshot.optionalBytes(path) !== null);
  if (presence.every((present) => !present)) return false;
  if (presence.some((present) => !present)) {
    throw new Error(`PROJECT_GRAPH_PRODUCER_INPUT_INCOMPLETE:${producer.id}`);
  }
  return true;
}

export function compileProjectGraph(
  snapshot: RepositorySnapshot,
  context: ProjectGraphContext,
  producers: readonly ProjectGraphProducer[],
): ObligationInput[] {
  const desired: ObligationInput[] = [];

  for (const producer of producers) {
    if (!producerActive(snapshot, producer)) continue;
    desired.push(...producer.produce(snapshot, context));
  }

  return desired;
}

export function managedProjectGraphPrefixes(
  snapshot: RepositorySnapshot,
  producers: readonly ProjectGraphProducer[],
): string[] {
  const managed = new Set<string>();
  for (const producer of producers) {
    if (!producerActive(snapshot, producer)) continue;
    for (const prefix of producer.managed_prefixes ?? []) {
      if (prefix.length === 0) throw new Error(`PROJECT_GRAPH_MANAGED_PREFIX_EMPTY:${producer.id}`);
      managed.add(prefix);
    }
  }
  return [...managed].sort();
}
