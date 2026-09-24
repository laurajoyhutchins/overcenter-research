import { ComposedFactStore } from '../../src/authority/store.ts';
import { DirectoryFactObjects, GitAuthorityHead } from './split-store.ts';

const [headRepo, objectRoot, ref, expectedHead, indexText] = process.argv.slice(2);
if (!headRepo || !objectRoot || !ref || !expectedHead || indexText === undefined) {
  throw new Error('usage: contender.ts <head-repo> <object-root> <ref> <expected-head> <index>');
}

const index = Number(indexText);
if (!Number.isInteger(index) || index < 0) throw new Error('INVALID_CONTENDER_INDEX');

const store = new ComposedFactStore(
  new DirectoryFactObjects(objectRoot),
  new GitAuthorityHead(headRepo, ref),
);

const commit = store.append(expectedHead, 'contender ' + String(index), {
  'claim.json': {
    schema: 'split-authority-contender/v1',
    contender: index,
  },
});

console.log(JSON.stringify({ index, commit }));
