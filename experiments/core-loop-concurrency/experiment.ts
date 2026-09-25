import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  bootstrapMedianInterval,
  median,
  pairedRatios,
} from '../../scripts/experiment-statistics.ts';
import { OvercenterKernel, runCoreLoop } from '../../src/authority/kernel.ts';

const TASKS = 32;
const TRIALS = 15;
const BOOTSTRAP_RESAMPLES = 20_000;
const MIN_MATERIAL_SPEEDUP = 2;
const CONCURRENCY = [1, 2, 4, 8] as const;
const EFFECT_MS = [0, 25, 100] as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = join(root, 'authority.sqlite');
  const kernel = new OvercenterKernel(db);
  kernel.initialize();
  for (let index = 0; index < TASKS; index += 1) {
    const id = 'task-' + String(index).padStart(4, '0');
    const path = join(root, id);
    kernel.define({
      id,
      packet: { path, content: id },
      postcondition: { verifier: 'file-content-equals/v1', path, content: id },
    });
  }
  return { root, kernel };
}

async function runCase(concurrency: number, effectMs: number) {
  const { root, kernel } = setup('core-loop-' + concurrency + '-' + effectMs + '-');
  let active = 0;
  let maxActive = 0;
  try {
    const started = performance.now();
    const result = await runCoreLoop(kernel, {
      concurrency,
      effect: async (packet) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (effectMs > 0) await sleep(effectMs);
        writeFileSync(String(packet.path), String(packet.content));
        active -= 1;
        return { kind: 'ok' };
      },
    });
    const elapsed = performance.now() - started;
    assert.equal(result.state, 'IDLE');
    assert.equal(result.advances, TASKS);
    assert.ok(kernel.inspect().every((work) => work.status === 'DONE'));
    return {
      concurrency,
      effect_ms: effectMs,
      tasks: TASKS,
      elapsed_ms: Number(elapsed.toFixed(3)),
      tasks_per_second: Number((TASKS / (elapsed / 1000)).toFixed(3)),
      max_active_effects: maxActive,
    };
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const results: Array<{
  concurrency: number;
  effect_ms: number;
  tasks: number;
  trials: number;
  median_elapsed_ms: number;
  tasks_per_second: number;
  max_active_effects: number;
  sample_tasks_per_second: number[];
  paired_speedup_median: number;
  paired_speedup_interval: {
    lower: number;
    upper: number;
    confidence: number;
    resamples: number;
  };
}> = [];

for (const effectMs of EFFECT_MS) {
  const samplesByConcurrency = new Map<number, Awaited<ReturnType<typeof runCase>>[]>(
    CONCURRENCY.map((concurrency) => [concurrency, []]),
  );

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const order = trial % 2 === 0 ? [...CONCURRENCY] : [...CONCURRENCY].reverse();
    for (const concurrency of order) {
      samplesByConcurrency.get(concurrency)!.push(await runCase(concurrency, effectMs));
    }
  }

  const baseline = samplesByConcurrency.get(1)!;
  const baselineThroughput = baseline.map((sample) => sample.tasks_per_second);

  for (const concurrency of CONCURRENCY) {
    const samples = samplesByConcurrency.get(concurrency)!;
    const elapsed = median(samples.map((sample) => sample.elapsed_ms));
    const ratios =
      concurrency === 1
        ? new Array<number>(TRIALS).fill(1)
        : pairedRatios(
            baselineThroughput,
            samples.map((sample) => sample.tasks_per_second),
          );
    const interval =
      concurrency === 1
        ? { lower: 1, upper: 1, confidence: 0.95, resamples: BOOTSTRAP_RESAMPLES }
        : bootstrapMedianInterval(ratios, {
            confidence: 0.95,
            resamples: BOOTSTRAP_RESAMPLES,
            seed: 0xc0ffee ^ effectMs ^ concurrency,
          });

    const result = {
      concurrency,
      effect_ms: effectMs,
      tasks: TASKS,
      trials: TRIALS,
      median_elapsed_ms: Number(elapsed.toFixed(3)),
      tasks_per_second: Number((TASKS / (elapsed / 1000)).toFixed(3)),
      max_active_effects: Math.max(...samples.map((sample) => sample.max_active_effects)),
      sample_tasks_per_second: samples.map((sample) =>
        Number(sample.tasks_per_second.toFixed(3)),
      ),
      paired_speedup_median: Number(median(ratios).toFixed(3)),
      paired_speedup_interval: {
        lower: Number(interval.lower.toFixed(3)),
        upper: Number(interval.upper.toFixed(3)),
        confidence: interval.confidence,
        resamples: interval.resamples,
      },
    };
    assert.ok(result.max_active_effects <= concurrency);
    results.push(result);
    console.log(JSON.stringify({ kind: 'core-loop-concurrency-case', ...result }));
  }
}

for (const effectMs of [25, 100]) {
  const treatment = results.find(
    (result) => result.effect_ms === effectMs && result.concurrency === 8,
  );
  assert.ok(treatment);
  assert.ok(
    treatment.paired_speedup_interval.lower > MIN_MATERIAL_SPEEDUP,
    'material speedup confidence bound failed at ' +
      effectMs +
      ' ms: ' +
      JSON.stringify(treatment.paired_speedup_interval),
  );
}

console.log(
  JSON.stringify({
    kind: 'core-loop-concurrency-summary',
    estimand: 'median within-round throughput ratio versus concurrency 1',
    trials: TRIALS,
    counterbalanced_order: true,
    material_speedup_decision: {
      concurrency: 8,
      effect_ms: [25, 100],
      lower_95_percent_bound_must_exceed: MIN_MATERIAL_SPEEDUP,
    },
    results,
  }),
);
