import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { OvercenterKernel, runCoreLoop } from '../../src/authority/kernel.ts';

const TASKS = 32;
const CONCURRENCY = [1, 2, 4, 8] as const;
const EFFECT_MS = [0, 25, 100] as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

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
  const { root, kernel } = setup(`core-loop-${concurrency}-${effectMs}-`);
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
}> = [];

for (const effectMs of EFFECT_MS) {
  for (const concurrency of CONCURRENCY) {
    const samples = [];
    for (let trial = 0; trial < 3; trial += 1) {
      samples.push(await runCase(concurrency, effectMs));
    }
    const elapsed = median(samples.map((sample) => sample.elapsed_ms));
    const result = {
      concurrency,
      effect_ms: effectMs,
      tasks: TASKS,
      trials: 3,
      median_elapsed_ms: Number(elapsed.toFixed(3)),
      tasks_per_second: Number((TASKS / (elapsed / 1000)).toFixed(3)),
      max_active_effects: Math.max(...samples.map((sample) => sample.max_active_effects)),
      sample_tasks_per_second: samples.map((sample) => sample.tasks_per_second),
    };
    assert.ok(result.max_active_effects <= concurrency);
    results.push(result);
    console.log(JSON.stringify({ kind: 'core-loop-concurrency-case', ...result }));
  }
}

console.log(
  JSON.stringify({
    kind: 'core-loop-concurrency-summary',
    results: results.map((result) => {
      const baseline = results.find(
        (candidate) => candidate.effect_ms === result.effect_ms && candidate.concurrency === 1,
      );
      assert.ok(baseline);
      return {
        ...result,
        speedup: Number((result.tasks_per_second / baseline.tasks_per_second).toFixed(3)),
        efficiency: Number(
          (result.tasks_per_second / (baseline.tasks_per_second * result.concurrency)).toFixed(3),
        ),
      };
    }),
  }),
);
