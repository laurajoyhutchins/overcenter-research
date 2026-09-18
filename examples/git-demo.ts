import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOvercenterKernel, runGitCoreLoop } from '../src/git-kernel.ts';

const dir = mkdtempSync(join(tmpdir(), 'overcenter-git-demo-'));
execFileSync('git', ['init', '--bare', dir], { stdio: 'ignore' });
const kernel = new GitOvercenterKernel(dir);
kernel.initialize();
const world = new Set();

kernel.define({ id: 'write-file', packet: { effect: 'file-exists' }, postcondition: { effect: 'file-exists' } });
kernel.define({ id: 'verify-build', deps: ['write-file'], packet: { effect: 'build-passes' }, postcondition: { effect: 'build-passes' } });

console.log('state ref before:', kernel.head());
console.log('before:', kernel.inspect().map(({ id, status }) => ({ id, status })));

const result = await runGitCoreLoop(kernel, {
  execute: async packet => { world.add(packet.effect); return { kind: 'ok' }; },
  observe: async work => ({ effect: world.has(work.packet.effect) ? work.packet.effect : 'absent', mutation_certainty: 'present' }),
  verify: (postcondition, observed) => postcondition.effect === observed.effect,
});

console.log('loop:', result);
console.log('state ref after:', kernel.head());
console.log('after:', kernel.inspect().map(({ id, status }) => ({ id, status })));
console.log('receipt commits:', kernel.receipts().map(({ obligation_id, disposition, settlement_commit }) => ({ obligation_id, disposition, settlement_commit })));
console.log('history:');
console.log(execFileSync('git', ['-C', dir, 'log', '--reverse', '--oneline', 'refs/overcenter/state'], { encoding: 'utf8' }).trim());

rmSync(dir, { recursive: true, force: true });
