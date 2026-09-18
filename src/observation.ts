import { readFileSync } from 'node:fs';
import type { Observation, Postcondition } from './model.ts';
import { sha256 } from './digest.ts';
import { findGithubCommitStatus, githubApiGet } from './providers/github-status.ts';

export interface ObservationContext {
  githubToken: string | null;
}

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
  throw new Error('UNSUPPORTED_POSTCONDITION');
}

export function observePostcondition(
  p: Postcondition,
  context: ObservationContext,
): Observation {
  validatePostcondition(p);

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
      const repository=githubApiGet(
        context.githubToken,
        `/repositories/${p.repository_id}`,
      ) as { id?: number; full_name?: string };
      if (repository.id!==p.repository_id || typeof repository.full_name!=='string') {
        throw new Error('GITHUB_REPOSITORY_IDENTITY_MISMATCH');
      }
      const status=findGithubCommitStatus(
        context.githubToken,
        repository.full_name,
        p.commit_sha,
        p.context,
      );
      if (!status) {
        return {
          verifier:p.verifier,
          provider:'github',
          repository_id:p.repository_id,
          repository_full_name:repository.full_name,
          commit_sha:p.commit_sha,
          context:p.context,
          expected_state:p.expected_state,
          mutation_certainty:'absent',
        };
      }
      return {
        verifier:p.verifier,
        provider:'github',
        repository_id:p.repository_id,
        repository_full_name:repository.full_name,
        commit_sha:p.commit_sha,
        context:p.context,
        expected_state:p.expected_state,
        actual_state:status.state,
        mutation_certainty:'present',
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

export function observationSatisfiesPostcondition(
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
