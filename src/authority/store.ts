import type { FactCommit } from './facts.ts';

export interface DurableFactStore {
  head(): string | null;
  append(
    expectedHead: string | null,
    message: string,
    files?: Record<string, unknown>,
  ): string | null;
  history(head: string): FactCommit[];
}

export interface ImmutableFactObject {
  files: Record<string, unknown>;
}

export interface ImmutableFactObjects {
  put(files: Record<string, unknown>): string;
  get(id: string): ImmutableFactObject;
}

export interface AuthorityHeadRecord {
  revision: string;
  parent: string | null;
  factId: string;
}

export interface AuthorityHead {
  head(): string | null;
  advance(expectedHead: string | null, factId: string, message: string): string | null;
  history(head: string): AuthorityHeadRecord[];
}

export class ComposedFactStore implements DurableFactStore {
  readonly objects: ImmutableFactObjects;
  readonly authority: AuthorityHead;

  constructor(objects: ImmutableFactObjects, authority: AuthorityHead) {
    this.objects = objects;
    this.authority = authority;
  }

  head(): string | null {
    return this.authority.head();
  }

  append(
    expectedHead: string | null,
    message: string,
    files: Record<string, unknown> = {},
  ): string | null {
    const factId = this.objects.put(files);
    return this.authority.advance(expectedHead, factId, message);
  }

  history(head: string): FactCommit[] {
    return this.authority.history(head).map(({ revision, parent, factId }) => {
      const fact = this.objects.get(factId);
      return factCommitFromFiles(revision, parent, fact.files);
    });
  }
}

export function factCommitFromFiles(
  commit: string,
  parent: string | null,
  files: Record<string, unknown>,
): FactCommit {
  return {
    commit,
    parent,
    graph_patch: files['graph-patch.json'] ?? null,
    claim: files['claim.json'] ?? null,
    execution_authority: files['execution-authority.json'] ?? null,
    effect_reservation: files['effect-reservation.json'] ?? null,
    effect_release: files['effect-release.json'] ?? null,
    receipt: files['receipt.json'] ?? null,
  };
}
