import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  AbsenceEvidenceCertificate,
  Observation,
  Postcondition,
} from './model.ts';
import {
  localFileEnoentEvidence,
  localFileEnoentEvidenceMatches,
  validateAbsenceEvidenceEnvelope,
} from './evidence.ts';
import {SettlementObservationSchema} from './generated/settlement-observation-schema.ts';
import {
  assertSupportedStructuralSchema,
  structurallyMatches,
} from './structural-schema.ts';
import {
  observeCertifiedGithubCommitStatus,
  type GithubJsonGet,
} from './providers/github-certified-status.ts';
import { githubGet, isGithubObjectId } from './providers/github-rest.ts';
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
  // Optional trusted confinement root for local-file observations. In confined
  // mode the observed file must be a direct child of this root and the final
  // component must not be a symlink. This deliberately avoids traversing
  // task-writable parent directories without an openat-style directory handle.
  localFileRoot?: string;
  clock?: () => string;
}

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const errorMessage=(e:unknown)=>e instanceof Error ? e.message : String(e);

function data(value:unknown):value is Record<string,unknown> {
  return !!value && typeof value==='object' && !Array.isArray(value);
}

assertSupportedStructuralSchema(SettlementObservationSchema);

const observationExternalRef=(ref:string,value:unknown):boolean=>{
  if (ref!=='#/$defs/AbsenceEvidenceEnvelope') return false;
  validateAbsenceEvidenceEnvelope(value);
  return true;
};

export function validateObservationEnvelope(
  value:unknown,
):asserts value is Observation {
  if (
    data(value)
    && Object.hasOwn(value,'verifier')
    && !structurallyMatches(
      SettlementObservationSchema.properties.verifier,
      value.verifier,
    )
  ) throw new Error('OBSERVATION_VERIFIER_INVALID');

  if (!structurallyMatches(
    SettlementObservationSchema,
    value,
    observationExternalRef,
  )) throw new Error('OBSERVATION_INVALID');
}

function readLocalFile(path:string,context:ObservationContext):string {
  const target=resolve(path);
  if (context.localFileRoot) {
    let root:string;
    try {
      root=realpathSync(context.localFileRoot);
    } catch {
      throw new Error('LOCAL_FILE_CONFINEMENT_ROOT_UNAVAILABLE');
    }
    if (dirname(target)!==root) {
      throw new Error('LOCAL_FILE_OUTSIDE_CONFINED_ROOT');
    }
  }

  const fd=openSync(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error('LOCAL_FILE_NOT_REGULAR');
    }
    return readFileSync(fd,'utf8');
  } finally {
    closeSync(fd);
  }
}

export function validatePostcondition(p: Postcondition): void {
  if (p?.verifier==='file-content-equals/v1'
    && typeof p.path==='string'
    && typeof p.content==='string') return;
  if (p?.verifier==='eventually-consistent-file-content-equals/v1'
    && typeof p.path==='string'
    && typeof p.content==='string') return;
  if (p?.verifier==='github-commit-status/v2'
    && p.provider==='github'
    && Number.isSafeInteger(p.repository_id)
    && p.repository_id > 0
    && typeof p.repository_full_name==='string'
    && /^[^/]+\/[^/]+$/.test(p.repository_full_name)
    && isGithubObjectId(p.commit_sha)
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

  if (p.verifier==='github-commit-status/v2') {
    const common={
      verifier:p.verifier,
      provider:'github' as const,
      repository_id:p.repository_id,
      repository_full_name:p.repository_full_name,
      commit_sha:p.commit_sha,
      context:p.context,
      expected_state:p.expected_state,
    };
    if (!context.githubToken) {
      return {
        ...common,
        mutation_certainty:'uncertain',
        observation_error:'GITHUB_TOKEN_UNAVAILABLE',
      };
    }

    const get=context.githubGet??githubGet;
    try {
      const status=observeCertifiedGithubCommitStatus(
        context.githubToken,
        {
          repositoryId:p.repository_id,
          repositoryFullName:p.repository_full_name,
          commitSha:p.commit_sha,
          context:p.context,
          get,
          ...(context.clock?{clock:context.clock}:{}),
        },
      );

      if (status.state==='indeterminate') {
        return {
          ...common,
          mutation_certainty:'uncertain',
          observation_error:status.reason,
          provider_evidence:status.evidence,
        };
      }
      return {
        ...common,
        actual_state:status.actual_state,
        mutation_certainty:'present',
        provider_evidence:status.evidence,
      };
    } catch (e: unknown) {
      return {
        ...common,
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
      const actual=readLocalFile(p.path,context);
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
    const actual=readLocalFile(p.path,context);
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
  validateObservationEnvelope(observed);
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
    || typeof observed.repository_full_name!=='string'
    || observed.repository_full_name.toLowerCase()
      !==postcondition.repository_full_name.toLowerCase()
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

  switch (postcondition.verifier) {
    case 'file-content-equals/v1':
      return localFileEnoentEvidenceMatches(
        observed.absence_evidence,
        postcondition.path,
      )
        ? observed.absence_evidence
        : null;
    case 'kubernetes-configmap-exists/v1':
      return kubernetesConfigMapAbsenceEvidenceMatches(
        observed.absence_evidence,
        postcondition,
      )
        ? observed.absence_evidence
        : null;
    default:
      return null;
  }
}

export function observationAuthoritativelyAbsent(
  postcondition:Postcondition,
  observed:Observation,
):boolean {
  return authoritativeAbsenceEvidence(postcondition,observed)!==null;
}

export function observationVerified(
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
