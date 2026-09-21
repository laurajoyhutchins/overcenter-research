import fs from 'node:fs';
import {resolveMutationProbes,mutatePatterns} from './resolve-mutation-probes.ts';

const resolved=resolveMutationProbes(process.cwd());
const requestedProbeIds=(process.env.MUTATION_PROBE??'')
  .split(',')
  .map(id=>id.trim())
  .filter(Boolean);
const requested=new Set(requestedProbeIds);
const selected=requested.size===0
  ? resolved
  : {...resolved,probes:resolved.probes.filter(probe=>requested.has(probe.id))};
if(requested.size!==0 && selected.probes.length!==requested.size){
  const found=new Set(selected.probes.map(probe=>probe.id));
  const unknown=[...requested].filter(id=>!found.has(id));
  throw new Error(`unknown mutation probe: ${unknown.join(',')}`);
}
fs.writeFileSync('mutation-ranges.json',JSON.stringify(selected,null,2)+'\n');

const broadTestCommand='node --experimental-strip-types --test test/digest-pure.test.ts test/semantic-dependency.test.ts test/hostile.test.ts test/projector-pure.test.ts test/projector-boundary.test.ts test/realization-admissibility.test.ts test/kernel-backend-differential.test.ts test/sqlite-kernel.test.ts test/git-kernel.test.ts test/provider-observation.test.ts';
const semanticIdentityTestCommand='node --experimental-strip-types --test test/semantic-dependency.test.ts test/hostile.test.ts';
const verificationAndAbsenceTestCommand='node --experimental-strip-types --test test/observation-hostile.test.ts';
const focusedTestCommands=new Map([
  ['semantic-identity',semanticIdentityTestCommand],
  ['verification-and-absence',verificationAndAbsenceTestCommand],
]);
const testCommand=requested.size===1
  ? focusedTestCommands.get([...requested][0])??broadTestCommand
  : broadTestCommand;

const config={
  mutate: mutatePatterns(selected),
  testRunner: 'command',
  commandRunner: {
    command: testCommand,
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

const output=process.argv[2]??'mutation-stryker-config.json';
fs.writeFileSync(output,JSON.stringify(config,null,2)+'\n');
