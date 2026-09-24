import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalDigest } from '../src/digest.ts';
import { evidenceRef } from '../src/evidence/reference.ts';
import {
  RESEARCH_RESULT_SCHEMA,
  RESEARCH_RESULT_SCHEMA_VERSION,
  researchClaimDigest,
  researchResultIdentity,
  trustResearchResult,
  validateResearchResult,
  type TrustedResearchResult,
} from '../src/research/result.ts';
import {
  RESEARCH_PLAN_SCHEMA,
  RESEARCH_PLAN_SCHEMA_VERSION,
  compileResearchPromotions,
  validateResearchPlan,
} from '../src/research/plan.ts';

const designA = canonicalDigest({
  question: 'Can result A justify promotion A?',
  criteria: ['A passes.'],
});
const designB = canonicalDigest({
  question: 'Can result B justify promotion B?',
  criteria: ['B passes.'],
});
const designC = canonicalDigest({
  question: 'Can result C justify promotion C?',
  criteria: ['C passes.'],
});

function rawResult({
  experiment,
  design,
  revision,
  outcome,
  claim,
  evidence,
}: {
  experiment: string;
  design: string;
  revision: string;
  outcome: 'supported' | 'falsified' | 'mixed' | 'inconclusive';
  claim: string;
  evidence: string;
}) {
  return {
    schema: RESEARCH_RESULT_SCHEMA,
    schema_version: RESEARCH_RESULT_SCHEMA_VERSION,
    experiment,
    design_digest: design,
    evaluated_revision: revision,
    outcome,
    claim,
    claim_digest: researchClaimDigest(claim),
    evidence: evidenceRef(Buffer.from(evidence)),
  };
}

function trusted(value: ReturnType<typeof rawResult>): TrustedResearchResult {
  const expected = value.evidence.digest;
  return trustResearchResult(value, (result) => {
    assert.equal(result.evidence.digest, expected);
  });
}

const plan = {
  schema: RESEARCH_PLAN_SCHEMA,
  schema_version: RESEARCH_PLAN_SCHEMA_VERSION,
  promotions: [
    {
      id: 'promotion-a',
      requires: ['result-a'],
      objective: 'Promote result A.',
      writable_paths: ['src/a.ts'],
    },
    {
      id: 'promotion-a-child',
      requires: [],
      after: ['promotion-a'],
      objective: 'Consume promotion A.',
      writable_paths: ['src/a-child.ts'],
    },
    {
      id: 'promotion-b',
      requires: ['result-b'],
      objective: 'Promote result B.',
      writable_paths: ['src/b.ts'],
    },
    {
      id: 'promotion-b-child',
      requires: [],
      after: ['promotion-b'],
      objective: 'Consume promotion B.',
      writable_paths: ['src/b-child.ts'],
    },
    {
      id: 'promotion-c',
      requires: ['result-c'],
      objective: 'Promote independent result C.',
      writable_paths: ['src/c.ts'],
    },
  ],
};

test('research result structure is not trusted evidence provenance', () => {
  const raw = rawResult({
    experiment: 'result-a',
    design: designA,
    revision: 'a'.repeat(40),
    outcome: 'supported',
    claim: 'A is supported.',
    evidence: 'evidence-a',
  });
  const parsed = validateResearchResult(raw);
  const forged = { result: parsed } as TrustedResearchResult;
  assert.throws(() => compileResearchPromotions(plan, [forged]), /RESEARCH_RESULT_UNTRUSTED/);
});

test('trusted verifier gates promotion activation', () => {
  const raw = rawResult({
    experiment: 'result-a',
    design: designA,
    revision: 'a'.repeat(40),
    outcome: 'supported',
    claim: 'A is supported.',
    evidence: 'evidence-a',
  });
  assert.throws(
    () =>
      trustResearchResult(raw, () => {
        throw new Error('EVIDENCE_NOT_CURRENT');
      }),
    /EVIDENCE_NOT_CURRENT/,
  );
});

test('trusted research result cannot be mutated after verification', () => {
  const value = trusted(
    rawResult({
      experiment: 'result-a',
      design: designA,
      revision: 'a'.repeat(40),
      outcome: 'falsified',
      claim: 'A is falsified.',
      evidence: 'sealed',
    }),
  );

  assert.throws(
    () => {
      (value.result as { outcome: string }).outcome = 'supported';
    },
    TypeError,
  );
  assert.equal(value.result.outcome, 'falsified');
});

test('only supported trusted results materialize promotions and semantic descendants', () => {
  const a = trusted(
    rawResult({
      experiment: 'result-a',
      design: designA,
      revision: 'a'.repeat(40),
      outcome: 'supported',
      claim: 'A is supported.',
      evidence: 'evidence-a',
    }),
  );
  const b = trusted(
    rawResult({
      experiment: 'result-b',
      design: designB,
      revision: 'b'.repeat(40),
      outcome: 'falsified',
      claim: 'B is falsified.',
      evidence: 'evidence-b',
    }),
  );
  const c = trusted(
    rawResult({
      experiment: 'result-c',
      design: designC,
      revision: 'c'.repeat(40),
      outcome: 'supported',
      claim: 'C is supported.',
      evidence: 'evidence-c',
    }),
  );

  const compiled = compileResearchPromotions(plan, [a, b, c]);
  assert.deepEqual(
    compiled.map((promotion) => promotion.id),
    ['promotion-a', 'promotion-a-child', 'promotion-c'],
  );
  assert.equal(compiled.some((promotion) => promotion.id === 'promotion-b'), false);
  assert.equal(compiled.some((promotion) => promotion.id === 'promotion-b-child'), false);
  assert.equal(compiled.find((promotion) => promotion.id === 'promotion-a')?.task.kind, 'source-change');
});

test('evidence-only rerun retains research and promotion semantic identity', () => {
  const first = trusted(
    rawResult({
      experiment: 'result-a',
      design: designA,
      revision: 'a'.repeat(40),
      outcome: 'supported',
      claim: 'A is supported.',
      evidence: 'first-run',
    }),
  );
  const rerun = trusted(
    rawResult({
      experiment: 'result-a',
      design: designA,
      revision: 'd'.repeat(40),
      outcome: 'supported',
      claim: 'A is supported.',
      evidence: 'second-run',
    }),
  );
  assert.equal(researchResultIdentity(first), researchResultIdentity(rerun));

  const withFirst = compileResearchPromotions(plan, [first]);
  const withRerun = compileResearchPromotions(plan, [rerun]);
  assert.deepEqual(
    withFirst.map(({ id, semantic_key }) => ({ id, semantic_key })),
    withRerun.map(({ id, semantic_key }) => ({ id, semantic_key })),
  );
});

test('changed research meaning invalidates only semantic descendants', () => {
  const originalA = trusted(
    rawResult({
      experiment: 'result-a',
      design: designA,
      revision: 'a'.repeat(40),
      outcome: 'supported',
      claim: 'A is supported.',
      evidence: 'a-original',
    }),
  );
  const changedA = trusted(
    rawResult({
      experiment: 'result-a',
      design: designA,
      revision: 'd'.repeat(40),
      outcome: 'supported',
      claim: 'A is supported only under a narrower contract.',
      evidence: 'a-changed',
    }),
  );
  const c = trusted(
    rawResult({
      experiment: 'result-c',
      design: designC,
      revision: 'c'.repeat(40),
      outcome: 'supported',
      claim: 'C is supported.',
      evidence: 'c',
    }),
  );

  const before = new Map(
    compileResearchPromotions(plan, [originalA, c]).map((promotion) => [
      promotion.id,
      promotion.semantic_key,
    ]),
  );
  const after = new Map(
    compileResearchPromotions(plan, [changedA, c]).map((promotion) => [
      promotion.id,
      promotion.semantic_key,
    ]),
  );

  assert.notEqual(before.get('promotion-a'), after.get('promotion-a'));
  assert.notEqual(before.get('promotion-a-child'), after.get('promotion-a-child'));
  assert.equal(before.get('promotion-c'), after.get('promotion-c'));
});

test('conflicting trusted results for one experiment fail closed', () => {
  const supported = trusted(
    rawResult({
      experiment: 'result-a',
      design: designA,
      revision: 'a'.repeat(40),
      outcome: 'supported',
      claim: 'A is supported.',
      evidence: 'supported',
    }),
  );
  const falsified = trusted(
    rawResult({
      experiment: 'result-a',
      design: designA,
      revision: 'b'.repeat(40),
      outcome: 'falsified',
      claim: 'A is falsified.',
      evidence: 'falsified',
    }),
  );
  assert.throws(
    () => compileResearchPromotions(plan, [supported, falsified]),
    /RESEARCH_RESULT_CONFLICT:result-a/,
  );
});

test('research plan excludes pull request and branch topology from semantic intent', () => {
  assert.throws(
    () =>
      validateResearchPlan({
        ...plan,
        promotions: [
          {
            ...plan.promotions[0],
            pull_request: 360,
          },
        ],
      }),
    /UNKNOWN_FIELD:pull_request/,
  );

  assert.throws(
    () =>
      validateResearchPlan({
        ...plan,
        promotions: [
          {
            ...plan.promotions[0],
            branch: 'stacked-on-something',
          },
        ],
      }),
    /UNKNOWN_FIELD:branch/,
  );
});

test('promotion dependency cycles fail rather than inventing an ordering', () => {
  assert.throws(
    () =>
      compileResearchPromotions(
        {
          schema: RESEARCH_PLAN_SCHEMA,
          schema_version: RESEARCH_PLAN_SCHEMA_VERSION,
          promotions: [
            {
              id: 'left',
              requires: [],
              after: ['right'],
              objective: 'Left.',
              writable_paths: ['src/left.ts'],
            },
            {
              id: 'right',
              requires: [],
              after: ['left'],
              objective: 'Right.',
              writable_paths: ['src/right.ts'],
            },
          ],
        },
        [],
      ),
    /RESEARCH_PROMOTION_DEPENDENCY_CYCLE:left,right/,
  );
});
