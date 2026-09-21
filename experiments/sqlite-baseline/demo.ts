import { OvercenterKernel, runCoreLoop } from './kernel.ts';

const kernel = new OvercenterKernel();
const world = new Set();

kernel.define({
  id: 'write-file',
  revision: 'demo-revision-1',
  packet: { effect: 'file-exists' },
  postcondition: { effect: 'file-exists' },
});
kernel.define({
  id: 'verify-build',
  revision: 'demo-revision-1',
  deps: ['write-file'],
  packet: { effect: 'build-passes' },
  postcondition: { effect: 'build-passes' },
});

console.log('before', kernel.inspect().map(({ id, status }) => ({ id, status })));

const result = await runCoreLoop(kernel, {
  execute: async packet => {
    world.add(packet.effect);
    return { kind: 'ok' };
  },
  observe: async work => ({
    effect: world.has(work.packet.effect) ? work.packet.effect : 'absent',
    mutation_certainty: 'present',
  }),
  verify: (postcondition, observed) => postcondition.effect === observed.effect,
});

console.log('loop', result);
console.log('after', kernel.inspect().map(({ id, status }) => ({ id, status })));
console.log('receipts', kernel.receipts().map(({ disposition, verified, observed }) => ({ disposition, verified, observed })));
kernel.close();
