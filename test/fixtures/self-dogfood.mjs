import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

const [tier, expectedSourceSha] = process.argv.slice(2);

if (!['regression', 'local'].includes(tier ?? '')) {
  console.error('DOGFOOD_TIER_INVALID');
  process.exit(2);
}
if (!/^[0-9a-f]{40,64}$/i.test(expectedSourceSha ?? '')) {
  console.error('DOGFOOD_SOURCE_SHA_INVALID');
  process.exit(2);
}

const expectedNode = readFileSync('/source/.node-version', 'utf8').trim();
if (process.versions.node !== expectedNode) {
  console.error(`DOGFOOD_NODE_VERSION_MISMATCH expected=${expectedNode} actual=${process.versions.node}`);
  process.exit(2);
}

const revision = spawnSync(
  '/usr/bin/git',
  ['-c', 'safe.directory=/source', '-C', '/source', 'rev-parse', 'HEAD'],
  {encoding: 'utf8', env: {PATH: '/usr/local/bin:/usr/bin:/bin'}},
);
if (revision.status !== 0) {
  process.stderr.write(revision.stderr ?? '');
  console.error('DOGFOOD_SOURCE_REVISION_UNAVAILABLE');
  process.exit(2);
}
const actualSourceSha = revision.stdout.trim().toLowerCase();
if (actualSourceSha !== expectedSourceSha.toLowerCase()) {
  console.error(`DOGFOOD_SOURCE_REVISION_MISMATCH expected=${expectedSourceSha} actual=${actualSourceSha}`);
  process.exit(2);
}

const npmCli = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
const args = tier === 'regression'
  ? [npmCli, 'test']
  : [npmCli, 'run', 'proof:local'];

const child = spawnSync('/usr/local/bin/node', args, {
  cwd: '/source',
  env: {
    HOME: '/tmp',
    NPM_CONFIG_CACHE: '/tmp/npm-cache',
    PATH: '/usr/local/bin:/usr/bin:/bin',
  },
  stdio: 'inherit',
});

if (child.error) {
  console.error(child.error);
  process.exit(1);
}
if (child.signal) {
  console.error(`DOGFOOD_EVIDENCE_SIGNAL:${child.signal}`);
  process.exit(1);
}
process.exit(child.status ?? 1);
