import type { RawObservation } from './openapi.ts';

export interface GitRefTargetFact {
  kind: 'binding';
  subject: {
    kind: 'github.ref';
    owner: string;
    repo: string;
    ref: string;
  };
  relation: 'targets';
  object: {
    kind: 'github.commit' | 'github.tag';
    sha: string;
  };
  evidence: {
    api_version: string;
    operation_id: string;
    status: number;
  };
}

export interface GitRefTargetObligation {
  owner: string;
  repo: string;
  ref: string;
  target_sha: string;
}

export interface ObligationEvaluation {
  state: 'SATISFIED' | 'UNSATISFIED' | 'INDETERMINATE';
  reason: string;
  fact?: GitRefTargetFact;
}

const sha = /^[0-9a-f]{40,64}$/i;
const canonicalRef = (ref: string) => ref.startsWith('refs/') ? ref : `refs/${ref}`;

export function projectGitRefTarget(observation: RawObservation): GitRefTargetFact | null {
  if (observation.contract.operation_id !== 'git/get-ref') return null;
  if (observation.outcome.status !== 200 || observation.outcome.visibility !== 'observed') return null;
  const body = observation.outcome.value as {
    ref?: unknown;
    object?: { type?: unknown; sha?: unknown };
  } | undefined;
  if (!body || typeof body.ref !== 'string' || !body.object) return null;
  if (!['commit', 'tag'].includes(String(body.object.type))) return null;
  if (typeof body.object.sha !== 'string' || !sha.test(body.object.sha)) return null;

  const owner = observation.request.parameters.owner;
  const repo = observation.request.parameters.repo;
  const requestedRef = observation.request.parameters.ref;
  if (typeof owner !== 'string' || typeof repo !== 'string' || typeof requestedRef !== 'string') return null;
  if (canonicalRef(body.ref) !== canonicalRef(requestedRef)) return null;

  return {
    kind: 'binding',
    subject: {
      kind: 'github.ref',
      owner,
      repo,
      ref: canonicalRef(body.ref),
    },
    relation: 'targets',
    object: {
      kind: body.object.type === 'commit' ? 'github.commit' : 'github.tag',
      sha: body.object.sha,
    },
    evidence: {
      api_version: observation.contract.api_version,
      operation_id: observation.contract.operation_id,
      status: observation.outcome.status,
    },
  };
}

export function evaluateGitRefTarget(
  observation: RawObservation,
  obligation: GitRefTargetObligation,
): ObligationEvaluation {
  if (observation.outcome.visibility === 'not-observed') {
    return { state: 'INDETERMINATE', reason: 'NOT_VISIBLE_IS_NOT_ABSENCE' };
  }
  if (observation.outcome.visibility === 'indeterminate') {
    return { state: 'INDETERMINATE', reason: 'OBSERVATION_INDETERMINATE' };
  }
  const fact = projectGitRefTarget(observation);
  if (!fact) return { state: 'INDETERMINATE', reason: 'OBSERVATION_DOES_NOT_PROVE_REF_BINDING' };

  const sameCoordinate = fact.subject.owner === obligation.owner
    && fact.subject.repo === obligation.repo
    && fact.subject.ref === canonicalRef(obligation.ref);
  if (!sameCoordinate) return { state: 'INDETERMINATE', reason: 'OBSERVATION_COORDINATE_MISMATCH', fact };

  return fact.object.sha.toLowerCase() === obligation.target_sha.toLowerCase()
    ? { state: 'SATISFIED', reason: 'AUTHORITATIVE_BINDING_MATCHES', fact }
    : { state: 'UNSATISFIED', reason: 'AUTHORITATIVE_BINDING_DIFFERS', fact };
}
