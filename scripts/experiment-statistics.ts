export interface ConfidenceInterval {
  lower: number;
  upper: number;
  confidence: number;
  resamples: number;
}

export interface UpperConfidenceBound {
  upper: number;
  confidence: number;
  resamples: number;
}

function requireFiniteValues(values: readonly number[], name: string): void {
  if (values.length === 0) throw new Error(`${name}:EMPTY`);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${name}:NON_FINITE`);
  }
}

export function median(values: readonly number[]): number {
  requireFiniteValues(values, 'MEDIAN');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function pairedRatios(baseline: readonly number[], treatment: readonly number[]): number[] {
  if (baseline.length !== treatment.length || baseline.length === 0) {
    throw new Error('PAIRED_RATIOS:INVALID_LENGTH');
  }
  requireFiniteValues(baseline, 'PAIRED_RATIOS_BASELINE');
  requireFiniteValues(treatment, 'PAIRED_RATIOS_TREATMENT');
  return treatment.map((value, index) => {
    const denominator = baseline[index]!;
    if (denominator <= 0 || value < 0) throw new Error('PAIRED_RATIOS:INVALID_VALUE');
    return value / denominator;
  });
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function quantile(sorted: readonly number[], probability: number): number {
  const index = Math.floor(probability * (sorted.length - 1));
  return sorted[index]!;
}

export function bootstrapMedianInterval(
  values: readonly number[],
  options: {
    confidence?: number;
    resamples?: number;
    seed?: number;
  } = {},
): ConfidenceInterval {
  requireFiniteValues(values, 'BOOTSTRAP');
  const confidence = options.confidence ?? 0.95;
  const resamples = options.resamples ?? 20_000;
  const seed = options.seed ?? 0xc0ffee;

  if (!(confidence > 0 && confidence < 1)) throw new Error('BOOTSTRAP:INVALID_CONFIDENCE');
  if (!Number.isSafeInteger(resamples) || resamples < 1) {
    throw new Error('BOOTSTRAP:INVALID_RESAMPLES');
  }

  const random = xorshift32(seed);
  const estimates = new Array<number>(resamples);
  const sample = new Array<number>(values.length);

  for (let iteration = 0; iteration < resamples; iteration += 1) {
    for (let index = 0; index < values.length; index += 1) {
      sample[index] = values[Math.floor(random() * values.length)]!;
    }
    estimates[iteration] = median(sample);
  }

  estimates.sort((left, right) => left - right);
  const alpha = (1 - confidence) / 2;
  return {
    lower: quantile(estimates, alpha),
    upper: quantile(estimates, 1 - alpha),
    confidence,
    resamples,
  };
}

export function bootstrapMedianUpperBound(
  values: readonly number[],
  options: {
    confidence?: number;
    resamples?: number;
    seed?: number;
  } = {},
): UpperConfidenceBound {
  const confidence = options.confidence ?? 0.95;
  if (!(confidence > 0.5 && confidence < 1)) {
    throw new Error('BOOTSTRAP_UPPER:INVALID_CONFIDENCE');
  }
  const interval = bootstrapMedianInterval(values, {
    confidence: 2 * confidence - 1,
    resamples: options.resamples,
    seed: options.seed,
  });
  return {
    upper: interval.upper,
    confidence,
    resamples: interval.resamples,
  };
}

export function zeroFailureUpperBound(trials: number, confidence = 0.95): number {
  if (!Number.isSafeInteger(trials) || trials < 1) throw new Error('ZERO_FAILURE:INVALID_TRIALS');
  if (!(confidence > 0 && confidence < 1)) {
    throw new Error('ZERO_FAILURE:INVALID_CONFIDENCE');
  }
  return 1 - (1 - confidence) ** (1 / trials);
}
