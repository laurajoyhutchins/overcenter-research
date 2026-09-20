import fs from 'node:fs';
import {resolveMutationProbes,mutatePatterns} from './resolve-mutation-probes.mjs';

const resolved=resolveMutationProbes(process.cwd());
fs.writeFileSync('mutation-ranges.json',JSON.stringify(resolved,null,2)+'\n');

export default {
  mutate: mutatePatterns(resolved),
  testRunner: 'command',
  commandRunner: {
    command: 'node --experimental-strip-types --test test/digest-pure.test.ts test/semantic-dependency.test.ts test/observation-hostile.test.ts test/projector-pure.test.ts test/projector-boundary.test.ts test/realization-admissibility.test.ts test/kernel-backend-differential.test.ts test/sqlite-kernel.test.ts test/git-kernel.test.ts test/provider-observation.test.ts',
  },
  coverageAnalysis: 'off',
  concurrency: 4,
  timeoutMS: 10_000,
  timeoutFactor: 2,
  reporters: ['clear-text','json'],
  jsonReporter: {
    fileName: 'mutation.json',
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
};
