import fs from 'node:fs';
import path from 'node:path';

const [rootArg, relative, syncDir] = process.argv.slice(2);
if (!rootArg || !relative || !syncDir) {
  console.error('usage: node-realpath-baseline.mjs <root> <relative> <sync-dir>');
  process.exit(2);
}

const root = fs.realpathSync(rootArg);
const candidate = path.join(root, relative);
const checked = fs.realpathSync(candidate);

if (checked !== root && !checked.startsWith(root + path.sep)) {
  console.error('candidate escaped root during preflight');
  process.exit(2);
}

fs.writeFileSync(path.join(syncDir, 'checked'), '1');

const waiter = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(path.join(syncDir, 'go'))) {
  Atomics.wait(waiter, 0, 0, 5);
}

// Stronger than readFileSync(candidate): O_NOFOLLOW rejects a symlink in the
// final component. It still does not anchor parent traversal to the directory
// tree that realpath() inspected.
const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
try {
  process.stdout.write(fs.readFileSync(fd, 'utf8'));
} finally {
  fs.closeSync(fd);
}
