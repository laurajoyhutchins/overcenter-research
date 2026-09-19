export default {
  mutate: [
    'src/digest.ts:3-20',
    'src/semantic-identity.ts:12-68',
    'src/projector.ts:205-258',
    'src/kernel-core.ts:243-271',
    'src/kernel-core.ts:281-320',
    'src/kernel-core.ts:446-462',
    'src/observation.ts:404-431',
  ],
  testRunner: 'command',
  commandRunner: {
    command: 'npm test',
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
