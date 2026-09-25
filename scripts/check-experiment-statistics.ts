import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync('experiments/registry.json', 'utf8')) as {
  entries: Array<{
    id: string;
    analysis?: unknown;
  }>;
};

const statisticalEntries = new Set([
  'core-loop-concurrency',
  'production-latency',
  'recovery-agent-search',
  'recovery-agent-refinement',
  'rust-executor-consolidation',
]);

const evidenceClasses = new Set([
  'exhaustive',
  'deterministic-corpus',
  'performance',
  'stochastic',
]);
const inferenceKinds = new Set(['confirmatory', 'descriptive', 'bounded-corpus']);
const uncertaintyMethods = new Set(['none', 'percentile-bootstrap', 'exact-binomial']);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}:EXPECTED_OBJECT`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}:EXPECTED_NONEMPTY_STRING`);
  }
  return value;
}

for (const entry of registry.entries) {
  if (entry.analysis === undefined) {
    if (statisticalEntries.has(entry.id)) {
      throw new Error(`${entry.id}:STATISTICAL_ANALYSIS_REQUIRED`);
    }
    continue;
  }
  if (!Array.isArray(entry.analysis) || entry.analysis.length === 0) {
    throw new Error(`${entry.id}:ANALYSIS_MUST_BE_NONEMPTY_ARRAY`);
  }

  for (const [index, rawClaim] of entry.analysis.entries()) {
    const label = `${entry.id}:analysis[${index}]`;
    const claim = record(rawClaim, label);
    const claimId = nonEmptyString(claim.claim_id, `${label}:claim_id`);
    const evidenceClass = nonEmptyString(claim.evidence_class, `${label}:evidence_class`);
    const inference = nonEmptyString(claim.inference, `${label}:inference`);

    if (!evidenceClasses.has(evidenceClass)) {
      throw new Error(`${label}:${claimId}:INVALID_EVIDENCE_CLASS`);
    }
    if (!inferenceKinds.has(inference)) {
      throw new Error(`${label}:${claimId}:INVALID_INFERENCE`);
    }

    if (evidenceClass !== 'performance' && evidenceClass !== 'stochastic') continue;

    nonEmptyString(claim.estimand, `${label}:${claimId}:estimand`);
    nonEmptyString(claim.stopping_rule, `${label}:${claimId}:stopping_rule`);

    const sampling = record(claim.sampling, `${label}:${claimId}:sampling`);
    nonEmptyString(sampling.unit, `${label}:${claimId}:sampling.unit`);
    const plannedN = sampling.planned_n;
    const actualN = sampling.actual_n;
    if (
      (plannedN === undefined || !Number.isSafeInteger(plannedN) || Number(plannedN) < 1) &&
      (actualN === undefined || !Number.isSafeInteger(actualN) || Number(actualN) < 1)
    ) {
      throw new Error(`${label}:${claimId}:SAMPLE_COUNT_REQUIRED`);
    }

    const uncertainty = record(claim.uncertainty, `${label}:${claimId}:uncertainty`);
    const method = nonEmptyString(uncertainty.method, `${label}:${claimId}:uncertainty.method`);
    if (!uncertaintyMethods.has(method)) {
      throw new Error(`${label}:${claimId}:INVALID_UNCERTAINTY_METHOD`);
    }

    if (method === 'none') {
      nonEmptyString(uncertainty.reason, `${label}:${claimId}:uncertainty.reason`);
    } else {
      const confidence = uncertainty.confidence;
      if (typeof confidence !== 'number' || !(confidence > 0 && confidence < 1)) {
        throw new Error(`${label}:${claimId}:INVALID_CONFIDENCE`);
      }
    }

    if (inference === 'confirmatory') {
      if (method === 'none') {
        throw new Error(`${label}:${claimId}:CONFIRMATORY_REQUIRES_UNCERTAINTY`);
      }
      nonEmptyString(claim.decision_rule, `${label}:${claimId}:decision_rule`);
    }
  }
}

console.log(
  JSON.stringify({
    kind: 'experiment-statistics-contract',
    statistical_entries: [...statisticalEntries].sort(),
    status: 'PASS',
  }),
);
