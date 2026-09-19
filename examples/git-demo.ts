import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOvercenterKernel } from '../src/git-kernel.ts';
import { runCoreLoop } from '../src/kernel-core.ts';

const root = mkdtempSync(join(tmpdir(), 'overcenter-git-demo-'));
const repo = join(root, 'state.git');
const file = join(root, 'artifact.txt');
const build = join(root, 'build.txt');

execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
const kernel = new GitOvercenterKernel(repo);
kernel.initialize();

kernel.define({
  id: 'write-file',
  packet: { path: file, content: 'file-exists' },
  postcondition: { verifier: 'file-content-equals/v1', path: file, content: 'file-exists' },
});
kernel.define({
  id: 'verify-build',
  dependencies: [{ kind: 'control', upstream: 'write-file' }],
  packet: { path: build, content: 'build-passes' },
  postcondition: { verifier: 'file-content-equals/v1', path: build, content: 'build-passes' },
});

console.log('state ref before:', kernel.head());
console.log('before:', kernel.inspect().map(({ id, status }) => ({ id, status })));

const result = await runCoreLoop(kernel, {
  effect: async packet => {
    writeFileSync(String(packet.path), String(packet.content));
    return { kind: 'ok' };
  },
});

console.log('loop:', result);
console.log('state ref after:', kernel.head());
console.log('after:', kernel.inspect().map(({ id, status }) => ({ id, status })));
console.log('receipt commits:', kernel.receipts().map(({ obligation_id, disposition, settlement_commit }) => ({
  obligation_id,
  disposition,
  settlement_commit,
})));
console.log('history:');
console.log(execFileSync('git', ['-C', repo, 'log', '--reverse', '--oneline', 'refs/overcenter/state'], { encoding: 'utf8' }).trim());

rmSync(root, { recursive: true, force: true });
