import { canonicalDigest } from '../digest.ts';
import { validateSourceTaskPacket, type SourceTaskPacket } from '../source/source-obligation.ts';
import { assertExactKeys, assertNonEmptyString, isData } from '../validation.ts';
import {
  assertTrustedResearchResult,
  researchResultIdentity,
  type TrustedResearchResult,
} from './result.ts';

export const RESEARCH_PLAN_SCHEMA = 'overcenter-research-plan' as const;
export const RESEARCH_PLAN_SCHEMA_VERSION = 1 as const;

export interface ResearchPromotionPlan {
  id: string;
  requires: string[];
  after: string[];
  objective: string;
  writable_paths: string[];
}

export interface ResearchPlan {
  schema: typeof RESEARCH_PLAN_SCHEMA;
  schema_version: typeof RESEARCH_PLAN_SCHEMA_VERSION;
  promotions: ResearchPromotionPlan[];
}

export interface ResearchPromotion {
  id: string;
  task: SourceTaskPacket;
  research_dependencies: Array<{
    experiment: string;
    identity: string;
  }>;
  promotion_dependencies: Array<{
    promotion: string;
    semantic_key: string;
  }>;
  semantic_key: string;
}

function stringArray(value: unknown, error: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(error);
  }
  if (new Set(value).size !== value.length) throw new Error(`${error}_DUPLICATE`);
  return [...value];
}

export function validateResearchPlan(value: unknown): ResearchPlan {
  if (!isData(value)) throw new Error('RESEARCH_PLAN_INVALID');
  assertExactKeys(value, ['schema', 'schema_version', 'promotions'], [], 'RESEARCH_PLAN_INVALID');
  if (value.schema !== RESEARCH_PLAN_SCHEMA) throw new Error('RESEARCH_PLAN_SCHEMA_MISMATCH');
  if (value.schema_version !== RESEARCH_PLAN_SCHEMA_VERSION) {
    throw new Error('RESEARCH_PLAN_SCHEMA_VERSION_UNSUPPORTED');
  }
  if (!Array.isArray(value.promotions)) throw new Error('RESEARCH_PLAN_PROMOTIONS_INVALID');

  const seen = new Set<string>();
  const promotions = value.promotions.map((candidate, index) => {
    if (!isData(candidate)) throw new Error(`RESEARCH_PROMOTION_INVALID:${index}`);
    assertExactKeys(
      candidate,
      ['id', 'requires', 'objective', 'writable_paths'],
      ['after'],
      `RESEARCH_PROMOTION_INVALID:${index}`,
    );
    assertNonEmptyString(candidate.id, `RESEARCH_PROMOTION_ID_INVALID:${index}`);
    if (seen.has(candidate.id)) throw new Error(`RESEARCH_PROMOTION_ID_DUPLICATE:${candidate.id}`);
    seen.add(candidate.id);
    assertNonEmptyString(candidate.objective, `RESEARCH_PROMOTION_OBJECTIVE_INVALID:${index}`);
    const requires = stringArray(
      candidate.requires,
      `RESEARCH_PROMOTION_REQUIRES_INVALID:${index}`,
    );
    const after = candidate.after === undefined
      ? []
      : stringArray(candidate.after, `RESEARCH_PROMOTION_AFTER_INVALID:${index}`);
    const task = validateSourceTaskPacket({
      schema: 'overcenter-source-task/v1',
      kind: 'source-change',
      objective: candidate.objective,
      writable_paths: candidate.writable_paths,
    });
    return {
      id: candidate.id,
      requires: [...requires].sort(),
      after: [...after].sort(),
      objective: task.objective,
      writable_paths: task.writable_paths,
    };
  });

  for (const promotion of promotions) {
    for (const upstream of promotion.after) {
      if (!seen.has(upstream)) throw new Error(`RESEARCH_PROMOTION_DEPENDENCY_UNKNOWN:${upstream}`);
      if (upstream === promotion.id) throw new Error(`RESEARCH_PROMOTION_DEPENDENCY_SELF:${upstream}`);
    }
  }

  return {
    schema: RESEARCH_PLAN_SCHEMA,
    schema_version: RESEARCH_PLAN_SCHEMA_VERSION,
    promotions,
  };
}

export function compileResearchPromotions(
  planValue: unknown,
  trustedResults: readonly TrustedResearchResult[],
): ResearchPromotion[] {
  const plan = validateResearchPlan(planValue);
  const results = new Map<
    string,
    { outcome: TrustedResearchResult['result']['outcome']; identity: string }
  >();

  for (const trusted of trustedResults) {
    assertTrustedResearchResult(trusted);
    const identity = researchResultIdentity(trusted);
    const experiment = trusted.result.experiment;
    const prior = results.get(experiment);
    if (prior && prior.identity !== identity) {
      throw new Error(`RESEARCH_RESULT_CONFLICT:${experiment}`);
    }
    results.set(experiment, { outcome: trusted.result.outcome, identity });
  }

  const plans = new Map(plan.promotions.map((promotion) => [promotion.id, promotion]));
  const remaining = new Set(plans.keys());
  const compiled = new Map<string, ResearchPromotion>();

  let changed = true;
  while (remaining.size > 0 && changed) {
    changed = false;
    for (const id of [...remaining].sort()) {
      const promotion = plans.get(id)!;
      const resultDependencies = promotion.requires.map((experiment) => ({
        experiment,
        result: results.get(experiment),
      }));

      if (
        resultDependencies.some(
          ({ result }) => result === undefined || result.outcome !== 'supported',
        )
      ) {
        remaining.delete(id);
        changed = true;
        continue;
      }

      const promotionDependencies: Array<{ promotion: string; semantic_key: string }> = [];
      let waiting = false;
      let blocked = false;
      for (const upstream of promotion.after) {
        const realized = compiled.get(upstream);
        if (realized) {
          promotionDependencies.push({
            promotion: upstream,
            semantic_key: realized.semantic_key,
          });
          continue;
        }
        if (remaining.has(upstream)) {
          waiting = true;
          break;
        }
        blocked = true;
        break;
      }
      if (waiting) continue;
      if (blocked) {
        remaining.delete(id);
        changed = true;
        continue;
      }

      const task = validateSourceTaskPacket({
        schema: 'overcenter-source-task/v1',
        kind: 'source-change',
        objective: promotion.objective,
        writable_paths: promotion.writable_paths,
      });
      const researchDependencies = resultDependencies
        .map(({ experiment, result }) => ({
          experiment,
          identity: result!.identity,
        }))
        .sort((left, right) => left.experiment.localeCompare(right.experiment));
      promotionDependencies.sort((left, right) => left.promotion.localeCompare(right.promotion));

      const semanticKey = canonicalDigest({
        domain: 'overcenter-research-promotion',
        id,
        task,
        research_dependencies: researchDependencies,
        promotion_dependencies: promotionDependencies,
      });

      compiled.set(id, {
        id,
        task,
        research_dependencies: researchDependencies,
        promotion_dependencies: promotionDependencies,
        semantic_key: semanticKey,
      });
      remaining.delete(id);
      changed = true;
    }
  }

  if (remaining.size > 0) {
    throw new Error(`RESEARCH_PROMOTION_DEPENDENCY_CYCLE:${[...remaining].sort().join(',')}`);
  }

  return [...compiled.values()].sort((left, right) => left.id.localeCompare(right.id));
}
