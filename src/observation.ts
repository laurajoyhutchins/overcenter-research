import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Observation, Postcondition } from './model.ts';
import {
  observeCertifiedGithubCommitStatus,
} from './providers/github-certified-status.ts';
import {
  canonicalGithubRef,
  observeCertifiedGithubRefTarget,
} from './providers/github-certified-ref.ts';
import type { GithubJsonGet } from './providers/github-status.ts';

export interface ObservationContext {
  githubToken: string | null;
  githubGet?: GithubJsonGet;
  clock?: () => string;
}

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const errorMessage=(e:unknown)=>e instanceof Error ? e.message : String(e);

export function validatePostcondition(p: Postcondition): void {
  if (p?.verifier==='file-content-equals/v1'
    && typeof p.path==='string'
    && typeof p.content==='string') return;
  if (p?.verifier==='eventually-consistent-file-content-equals/v1'
    && typeof p.path==='string'
    && typeof p.content==='string') return;
  if (p?.verifier==='github-commit-status/v1'
    && p.provider==='github'
    && Number.isSafeInteger(p.repository_id)
    && p.repository_id > 0
    && /^[0-9a-f]{40,64}$/i.test(p.commit_sha)
    && typeof p.context==='string'
    && p.context.length > 0
    && ['error','failure','pending','success'].includes(p.expected_state)) return;
  if (p?.verifier==='github-ref-target/v1'
    && p.provider==='github'
    && Number.isSafeInteger(p.repository_id)
    && p.repository_id > 0
    && typeof p.ref==='string'
    && /^(?:refs\/)?(?:heads|tags)\/.+/.test(p.ref)
    && /^[0-9a-f]{40,64}$/i.test(p.target_sha)) return;
  throw new Error('UNSUPPORTED_POSTCONDITION');
}

export function observePostcondition(
  p: Postcondition,
  context: ObservationContext,
): Observation {
  validatePostcondition(p);

  if (p.verifier==='github-ref-target/v1') {
    if (!context.githubToken) {
      return {
        verifier:p.verifier,
        provider:'github',
        repository_id:p.repository_id,
        ref:canonicalGithubRef(p.ref),
        target_sha:p.target_sha,
        mutation_certainty:'uncertain',
        observation_error:'GITHUB_TOKEN_UNAVAILABLE',
      };
    }
    try {
      const binding=observeCertifiedGithubRefTarget(
        context.githubToken,
        {
          repositoryId:p.repository_id,
          ref:p.ref,
          targetSha:p.target_sha,
          ...(context.githubGet?{get:context.githubGet}:{}),
          ...(context.clock?{clock:context.clock}:{}),
        },
      );
      return {
        verifier:p.verifier,
        provider:'github',
        repository_id:p.repository_id,
        repository_full_name:binding.repository_full_name,
        ref:binding.ref,
        target_sha:p.target_sha,
        actual_target_sha:binding.actual_target_sha,
        mutation_certainty:binding.state==='present'?'present':'absent',
        provider_evidence:binding.evidence,
      };
    } catch (e: unknown) {
      return {
        verifier:p.verifier,
        provider:'github',
        repository_id:p.repository_id,
        ref:canonicalGithubRef(p.ref),
        target_sha:p.target_sha,
        mutation_certainty:'uncertain',
        negative_evidence_authoritative:false,
        observation_error:errorMessage(e),
      };
    }
  }

  if (p.verifier==='github-commit-status/v1') {
    if (!context.githubToken) {
      return {
        verifier:p.verifier,
        provider:'github',
        repository_id:p.repository_id,
        commit_sha:p.commit_sha,
        context:p.context,
        expected_state:p.expected_state,
        mutation_certainty:'uncertain',
        observation_error:'GITHUB_TOKEN_UNAVAILABLE',
      };
    }
    try {
      const status=observeCertifiedGithubCommitStatus(
        context.githubToken,
        {
          repositoryId:p.repository_id,
          commitSha:p.commit_sha,
          context:p.context,
          ...(context.githubGet?{get:context.githubGet}:{}),
          ...(context.clock?{clock:context.clock}:{}),
        },
      );
      if (status.state==='indeterminate') {
        return {
          verifier:p.verifier,
          provider:'github',
          repository_id:p.repository_id,
          repository_full_name:status.repository_full_name,
          commit_sha:p.commit_sha,
          context:p.context,
          expected_state:p.expected_state,
          mutation_certainty:'uncertain',
          negative_evidence_authoritative:false,
          observation_error:status.reason,
          provider_evidence:status.evidence,
          legacy_interpretation:status.legacy_interpretation,
        };
      }
      return {
        verifier:p.verifier,
        provider:'github',
        repository_id:p.repository_id,
        repository_full_name:status.repository_full_name,
        commit_sha:p.commit_sha,
        context:p.context,
        expected_state:p.expected_state,
        actual_state:status.actual_state,
        mutation_certainty:'present',
        provider_evidence:status.evidence,
        legacy_interpretation:status.legacy_interpretation,
      };
    } catch (e: unknown) {
      return {
        verifier:p.verifier,
        provider:'github',
        repository_id:p.repository_id,
        commit_sha:p.commit_sha,
        context:p.context,
        expected_state:p.expected_state,
        mutation_certainty:'uncertain',
        observation_error:errorMessage(e),
      };
    }
  }

  if (p.verifier==='eventually-consistent-file-content-equals/v1') {
    const expected=sha256(p.content);
    try {
      const actual=readFileSync(p.path,'utf8');
      const actualSha=sha256(actual);
      if (actual===p.content) {
        return {
          verifier:p.verifier,
          path:p.path,
          expected_sha256:expected,
          actual_sha256:actualSha,
          mutation_certainty:'present',
        };
      }
      return {
        verifier:p.verifier,
        path:p.path,
        expected_sha256:expected,
        actual_sha256:actualSha,
        mutation_certainty:'uncertain',
        negative_evidence_authoritative:false,
        observation_error:'NON_MATCHING_READ_NOT_AUTHORITATIVE',
      };
    } catch (e: unknown) {
      const code=(e as {code?:string}).code;
      if (code==='ENOENT') {
        return {
          verifier:p.verifier,
          path:p.path,
          expected_sha256:expected,
          mutation_certainty:'uncertain',
          negative_evidence_authoritative:false,
          observation_error:'NEGATIVE_READ_NOT_AUTHORITATIVE',
        };
      }
      return {
        verifier:p.verifier,
        path:p.path,
        expected_sha256:expected,
        mutation_certainty:'uncertain',
        observation_error:errorMessage(e),
      };
    }
  }

  const expected=sha256(p.content);
  try {
    const actual=readFileSync(p.path,'utf8');
    const actualSha=sha256(actual);
    return {
      verifier:p.verifier,
      path:p.path,
      expected_sha256:expected,
      actual_sha256:actualSha,
      mutation_certainty:'present',
    };
  } catch (e: unknown) {
    const code=(e as {code?:string}).code;
    if (code==='ENOENT') {
      return {
        verifier:p.verifier,
        path:p.path,
        expected_sha256:expected,
        mutation_certainty:'absent',
      };
    }
    return {
      verifier:p.verifier,
      path:p.path,
      expected_sha256:expected,
      mutation_certainty:'uncertain',
      observation_error:errorMessage(e),
    };
  }
}

export function observationVerified(
  postcondition: Postcondition,
  observed: Observation,
): boolean {
  if (observed.verifier!==postcondition.verifier) {
    throw new Error('OBSERVATION_VERIFIER_MISMATCH');
  }
  if (observed.mutation_certainty!=='present') return false;

  if (
    postcondition.verifier==='file-content-equals/v1'
    || postcondition.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    if (observed.path!==postcondition.path) {
      throw new Error('OBSERVATION_COORDINATE_MISMATCH');
    }
    return observed.actual_sha256===sha256(postcondition.content);
  }

  if (postcondition.verifier==='github-ref-target/v1') {
    if (
      observed.provider!=='github'
      || observed.repository_id!==postcondition.repository_id
      || observed.ref!==canonicalGithubRef(postcondition.ref)
      || observed.target_sha?.toLowerCase()!==postcondition.target_sha.toLowerCase()
    ) {
      throw new Error('OBSERVATION_COORDINATE_MISMATCH');
    }
    return observed.actual_target_sha?.toLowerCase()===postcondition.target_sha.toLowerCase();
  }

  if (
    observed.provider!=='github'
    || observed.repository_id!==postcondition.repository_id
    || observed.commit_sha!==postcondition.commit_sha
    || observed.context!==postcondition.context
  ) {
    throw new Error('OBSERVATION_COORDINATE_MISMATCH');
  }
  return observed.actual_state===postcondition.expected_state;
}
