import { readFileSync } from 'node:fs';
import { sha256 } from './digest.ts';
import type {
  AbsenceEvidenceCertificate,
  Observation,
  Postcondition,
} from './model.ts';
import {
  localFileEnoentEvidence,
  localFileEnoentEvidenceMatches,
} from './evidence.ts';
import {
  observeCertifiedGithubCommitStatus,
  type GithubJsonGet,
} from './providers/github-certified-status.ts';
import { githubGet } from './providers/github-rest.ts';
import {
  kubernetesConfigMapAbsenceEvidenceMatches,
  observeCertifiedKubernetesConfigMap,
  type KubernetesListConfigMaps,
} from './providers/kubernetes-configmap.ts';

export interface ObservationContext {
  githubToken: string | null;
  githubGet?: GithubJsonGet;
  kubernetesListConfigMaps?: KubernetesListConfigMaps;
  kubernetesListLimit?: number;
  clock?: () => string;
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
  if (p?.verifier==='github-commit-status/v2'
    && p.provider==='github'
    && Number.isSafeInteger(p.repository_id)
    && p.repository_id > 0
    && typeof p.repository_full_name==='string'
    && /^[^/]+\/[^/]+$/.test(p.repository_full_name)
    && /^[0-9a-f]{40,64}$/i.test(p.commit_sha)
    && typeof p.context==='string'
    && p.context.length > 0
    && ['error','failure','pending','success'].includes(p.expected_state)) return;
  if (p?.verifier==='kubernetes-configmap-exists/v1'
    && p.provider==='kubernetes'
    && typeof p.authority_id==='string'
    && p.authority_id.length > 0
    && p.api_group===''
    && p.resource==='configmaps'
    && typeof p.namespace==='string'
    && p.namespace.length > 0
    && typeof p.name==='string'
    && p.name.length > 0) return;
  throw new Error('UNSUPPORTED_POSTCONDITION');
}

export function observePostcondition(
  p: Postcondition,
  context: ObservationContext,
): Observation {
  validatePostcondition(p);

  if (
    p.verifier==='github-commit-status/v1'
    || p.verifier==='github-commit-status/v2'
  ) {
    const common={
      verifier:p.verifier,
      provider:'github' as const,
      repository_id:p.repository_id,
      commit_sha:p.commit_sha,
      context:p.context,
      expected_state:p.expected_state,
    };
    if (!context.githubToken) {
      return {
        ...common,
        ...(p.verifier==='github-commit-status/v2'
          ? {repository_full_name:p.repository_full_name}
          : {}),
        mutation_certainty:'uncertain',
        observation_error:'GITHUB_TOKEN_UNAVAILABLE',
      };
    }

    const get=context.githubGet??githubGet;
    try {
      let repositoryFullName:string;
      let bootstrapHint:Record<string,unknown>|undefined;
      if (p.verifier==='github-commit-status/v2') {
        repositoryFullName=p.repository_full_name;
      } else {
        const hint=get(
          context.githubToken,
          `/repositories/${p.repository_id}`,
        ) as {id?:number;full_name?:string};
        if (hint.id!==p.repository_id || typeof hint.full_name!=='string') {
          throw new Error('GITHUB_REPOSITORY_HINT_INVALID');
        }
        repositoryFullName=hint.full_name;
        bootstrapHint={
          endpoint:'/repositories/{repository_id}',
          repository_id:p.repository_id,
          full_name:repositoryFullName,
          authoritative:false,
        };
      }

      const status=observeCertifiedGithubCommitStatus(
        context.githubToken,
        {
          repositoryId:p.repository_id,
          repositoryFullName,
          commitSha:p.commit_sha,
          context:p.context,
          get,
          ...(context.clock?{clock:context.clock}:{}),
        },
      );
      const providerEvidence=bootstrapHint
        ? {...status.evidence,bootstrap_hint:bootstrapHint}
        : status.evidence;

      if (status.state==='indeterminate') {
        return {
          ...common,
          repository_full_name:status.repository_full_name,
          mutation_certainty:'uncertain',
          observation_error:status.reason,
          provider_evidence:providerEvidence,
        };
      }
      return {
        ...common,
        repository_full_name:status.repository_full_name,
        actual_state:status.actual_state,
        mutation_certainty:'present',
        provider_evidence:providerEvidence,
      };
    } catch (e: unknown) {
      return {
        ...common,
        ...(p.verifier==='github-commit-status/v2'
          ? {repository_full_name:p.repository_full_name}
          : {}),
        mutation_certainty:'uncertain',
        observation_error:errorMessage(e),
      };
    }
  }

  if (p.verifier==='kubernetes-configmap-exists/v1') {
    const common={
      verifier:p.verifier,
      provider:'kubernetes' as const,
      authority_id:p.authority_id,
      api_group:p.api_group,
      resource:p.resource,
      namespace:p.namespace,
      name:p.name,
    };
    if (!context.kubernetesListConfigMaps) {
      return {
        ...common,
        mutation_certainty:'uncertain',
        observation_error:'KUBERNETES_LIST_TRANSPORT_UNAVAILABLE',
      };
    }
    const result=observeCertifiedKubernetesConfigMap(p,{
      list:context.kubernetesListConfigMaps,
      ...(context.kubernetesListLimit===undefined
        ? {}
        : {limit:context.kubernetesListLimit}),
    });
    if (result.state==='present') {
      return {
        ...common,
        mutation_certainty:'present',
        observed_uid:result.uid,
        observed_resource_version:result.resource_version,
        snapshot_resource_version:result.snapshot_resource_version,
        provider_evidence:result.provider_evidence,
      };
    }
    if (result.state==='absent') {
      return {
        ...common,
        mutation_certainty:'absent',
        snapshot_resource_version:result.snapshot_resource_version,
        absence_evidence:result.absence_evidence,
        provider_evidence:result.provider_evidence,
      };
    }
    return {
      ...common,
      mutation_certainty:'uncertain',
      observation_error:result.reason,
      provider_evidence:result.provider_evidence,
    };
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
        absence_evidence:localFileEnoentEvidence(p.path),
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

function assertObservationCoordinate(
  postcondition:Postcondition,
  observed:Observation,
):void {
  if (observed.verifier!==postcondition.verifier) {
    throw new Error('OBSERVATION_VERIFIER_MISMATCH');
  }

  if (
    postcondition.verifier==='file-content-equals/v1'
    || postcondition.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    if (observed.path!==postcondition.path) {
      throw new Error('OBSERVATION_COORDINATE_MISMATCH');
    }
    return;
  }

  if (postcondition.verifier==='kubernetes-configmap-exists/v1') {
    if (
      observed.provider!=='kubernetes'
      || observed.authority_id!==postcondition.authority_id
      || observed.api_group!==postcondition.api_group
      || observed.resource!==postcondition.resource
      || observed.namespace!==postcondition.namespace
      || observed.name!==postcondition.name
    ) {
      throw new Error('OBSERVATION_COORDINATE_MISMATCH');
    }
    return;
  }

  if (
    observed.provider!=='github'
    || observed.repository_id!==postcondition.repository_id
    || (
      postcondition.verifier==='github-commit-status/v2'
      && (
        typeof observed.repository_full_name!=='string'
        || observed.repository_full_name.toLowerCase()
          !==postcondition.repository_full_name.toLowerCase()
      )
    )
    || observed.commit_sha!==postcondition.commit_sha
    || observed.context!==postcondition.context
  ) {
    throw new Error('OBSERVATION_COORDINATE_MISMATCH');
  }
}

export function authoritativeAbsenceEvidence(
  postcondition:Postcondition,
  observed:Observation,
):AbsenceEvidenceCertificate|null {
  assertObservationCoordinate(postcondition,observed);
  if (observed.mutation_certainty!=='absent') return null;

  if (postcondition.verifier==='file-content-equals/v1') {
    return localFileEnoentEvidenceMatches(
      observed.absence_evidence,
      postcondition.path,
    )
      ? observed.absence_evidence
      : null;
  }

  if (postcondition.verifier==='kubernetes-configmap-exists/v1') {
    return kubernetesConfigMapAbsenceEvidenceMatches(
      observed.absence_evidence,
      postcondition,
    )
      ? observed.absence_evidence
      : null;
  }

  return null;
}

export function observationAuthoritativelyAbsent(
  postcondition:Postcondition,
  observed:Observation,
):boolean {
  return authoritativeAbsenceEvidence(postcondition,observed)!==null;
}

export function observationSatisfiesPostcondition(
  postcondition: Postcondition,
  observed: Observation,
): boolean {
  assertObservationCoordinate(postcondition,observed);
  if (observed.mutation_certainty!=='present') return false;

  if (
    postcondition.verifier==='file-content-equals/v1'
    || postcondition.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    return observed.actual_sha256===sha256(postcondition.content);
  }

  if (postcondition.verifier==='kubernetes-configmap-exists/v1') {
    return typeof observed.observed_uid==='string'
      && observed.observed_uid.length>0
      && typeof observed.observed_resource_version==='string'
      && observed.observed_resource_version.length>0;
  }

  return observed.actual_state===postcondition.expected_state;
}
