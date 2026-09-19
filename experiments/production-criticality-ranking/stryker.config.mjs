export default {
  mutate: [
    'src/digest.ts:3-20',
    'src/projector.ts:205-258',
  ],
  testRunner: 'command',
  commandRunner: {
    command: 'node --experimental-strip-types --test test/digest-pure.test.ts test/projector-pure.test.ts test/projector-explanation.test.ts test/realization-admissibility.test.ts test/projection-reconstruction.test.ts test/dependency-edge-adversarial.test.ts',
  },
  coverageAnalysis: 'off',
  concurrency: 4,
  timeoutMS: 10_000,
  timeoutFactor: 2,
  reporters: ['clear-text', 'json'],
  jsonReporter: {
    fileName: 'mutation.json',
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
};
