import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type AuthorityHead,
  type AuthorityHeadRecord,
  ComposedFactStore,
  type ImmutableFactObject,
  type ImmutableFactObjects,
} from '../src/authority/store.ts';

class MemoryFactObjects implements ImmutableFactObjects {
  readonly objects = new Map<string, ImmutableFactObject>();
  #sequence = 0;

  put(files: Record<string, unknown>): string {
    const id = 'fact-' + String(++this.#sequence);
    this.objects.set(id, { files });
    return id;
  }

  get(id: string): ImmutableFactObject {
    const object = this.objects.get(id);
    if (!object) throw new Error('FACT_OBJECT_MISSING:' + id);
    return object;
  }
}

class MemoryAuthorityHead implements AuthorityHead {
  readonly records: AuthorityHeadRecord[] = [];
  #head: string | null = null;

  head(): string | null {
    return this.#head;
  }

  advance(expectedHead: string | null, factId: string): string | null {
    if (this.#head !== expectedHead) return null;
    const revision = 'revision-' + String(this.records.length + 1);
    this.records.push({
      revision,
      parent: this.#head,
      factId,
    });
    this.#head = revision;
    return revision;
  }

  history(head: string): AuthorityHeadRecord[] {
    const index = this.records.findIndex((record) => record.revision === head);
    if (index < 0) throw new Error('UNKNOWN_AUTHORITY_HEAD');
    return this.records.slice(0, index + 1);
  }
}

test('ComposedFactStore separates immutable publication from authority CAS', () => {
  const objects = new MemoryFactObjects();
  const authority = new MemoryAuthorityHead();
  const store = new ComposedFactStore(objects, authority);

  const initial = store.append(null, 'initialize');
  assert.equal(initial, 'revision-1');

  const defined = store.append(initial, 'define', {
    'graph-patch.json': { schema: 'test-graph-patch/v1' },
  });
  assert.equal(defined, 'revision-2');

  const stale = store.append(initial, 'stale writer', {
    'claim.json': { schema: 'must-remain-unreachable/v1' },
  });
  assert.equal(stale, null);
  assert.equal(objects.objects.size, 3);

  const history = store.history(defined);
  assert.equal(history.length, 2);
  assert.equal(history[1]?.graph_patch?.schema, 'test-graph-patch/v1');
  assert.equal(history.some((record) => record.claim !== null), false);
  assert.equal(authority.records.length, 2);
});

test('ComposedFactStore fails closed when authority references a missing object', () => {
  const objects = new MemoryFactObjects();
  const authority = new MemoryAuthorityHead();
  const store = new ComposedFactStore(objects, authority);

  const initial = store.append(null, 'initialize');
  assert.ok(initial);
  const referenced = authority.records[0]?.factId;
  assert.ok(referenced);
  objects.objects.delete(referenced);

  assert.throws(() => store.history(initial), /FACT_OBJECT_MISSING/);
  assert.equal(store.head(), initial);
});
