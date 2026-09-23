import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const OLD_CONTRACT_PATHS = [
  'contracts/authority-facts-v1',
  'contracts/computation-execution-v1',
  'contracts/observation-evidence-v1',
  '../authority-facts-v1',
  '../computation-execution-v1',
  '../observation-evidence-v1',
];

function filesUnder(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) found.push(...filesUnder(path));
    else if (stat.isFile()) found.push(path.replaceAll('\\', '/'));
  }
  return found;
}

test('stable contract names do not encode schema versions', () => {
  const contractFiles = filesUnder('contracts');

  const versionedPaths = contractFiles.filter((path) =>
    path.split('/').some((segment) => /-v\d+$/.test(segment)),
  );
  assert.deepEqual(versionedPaths, []);

  const versionedDefinitions: string[] = [];
  const versionedTitles: string[] = [];
  const versionedContractRefs: string[] = [];
  for (const path of contractFiles.filter((path) => path.endsWith('.json'))) {
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (path.endsWith('/schema.json')) {
      const defs = (document.$defs ?? {}) as Record<string, unknown>;
      for (const name of Object.keys(defs)) {
        if (/V\d+$/.test(name)) versionedDefinitions.push(`${path}#/$defs/${name}`);
      }
      if (typeof document.title === 'string' && /\bv\d+\b/i.test(document.title)) {
        versionedTitles.push(`${path}: ${document.title}`);
      }
    }
    const text = JSON.stringify(document);
    for (const oldPath of OLD_CONTRACT_PATHS) {
      if (text.includes(oldPath)) versionedContractRefs.push(`${path}: ${oldPath}`);
    }
    for (const match of text.matchAll(/"definition":"([^"]*V\d+)"/g)) {
      versionedDefinitions.push(`${path}: ${match[1]}`);
    }
  }

  assert.deepEqual(versionedDefinitions, []);
  assert.deepEqual(versionedTitles, []);
  assert.deepEqual(versionedContractRefs, []);

  const exportedVersionedTypes: string[] = [];
  for (const path of filesUnder('src').filter((path) => path.endsWith('.ts'))) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(
      /export\s+(?:interface|type|class)\s+([A-Za-z_$][A-Za-z0-9_$]*V\d+)\b/g,
    )) {
      exportedVersionedTypes.push(`${path}: ${match[1]}`);
    }
  }
  assert.deepEqual(exportedVersionedTypes, []);

  const stalePathReferences: string[] = [];
  const scanRoots = ['.github', 'src', 'scripts', 'test', 'examples', 'experiments', 'contracts'];
  const scanFiles = scanRoots
    .flatMap((root) => filesUnder(root))
    .filter((path) => path !== 'test/stable-contract-names.test.ts')
    .filter((path) => /\.(?:ts|tsx|js|json|md|ya?ml|sh|toml|go|rs)$/.test(path));
  for (const path of scanFiles) {
    const text = readFileSync(path, 'utf8');
    for (const oldPath of OLD_CONTRACT_PATHS) {
      if (text.includes(oldPath)) stalePathReferences.push(`${path}: ${oldPath}`);
    }
  }
  for (const path of ['README.md', 'ARCHITECTURE.md', 'package.json', 'tsconfig.json']) {
    const text = readFileSync(path, 'utf8');
    for (const oldPath of OLD_CONTRACT_PATHS) {
      if (text.includes(oldPath)) stalePathReferences.push(`${path}: ${oldPath}`);
    }
  }
  assert.deepEqual(stalePathReferences, []);
});
