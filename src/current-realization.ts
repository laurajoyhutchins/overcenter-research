import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sha256 } from './digest.ts';
import type {
  HistoricalRun,
  Receipt,
  State,
} from './facts.ts';
import { obligationKey, type RealizationStatus } from './lifecycle.ts';
import type {
  AbsenceEvidenceCertificate,
  Observation,
  Postcondition,
} from './model.ts';
import { githubStatusContextKey } from './providers/github-rest.ts';

export interface CurrentLifecycle {
  status:RealizationStatus;
  sourceRun?:HistoricalRun;
  executionRun?:HistoricalRun;
}

export type CurrentObservationSnapshot=Record<string,Observation>;

interface LeanRun {
  run_id:string;
  obligation_key:string;
  status:'EXECUTING'|'WAITING'|'RECOVERY_REQUIRED'|'DONE'|'READY';
}

interface LeanProjection {
  schema:'overcenter-lean-realization-projection/v1';
  lifecycle:RealizationStatus;
  source_run_id:string|null;
  execution_run_id:string|null;
}

const DEFAULT_PROJECTOR=fileURLToPath(
  new URL(
    '../experiments/lean-kernel/.lake/build/bin/overcenterRealizationProjection',
    import.meta.url,
  ),
);

function verifierRevision(postcondition:Postcondition):string {
  return `${postcondition.verifier}@semantics-1`;
}

function githubCoordinate(postcondition:Extract<
  Postcondition,
  {verifier:'github-commit-status/v1'|'github-commit-status/v2'}
>):string {
  return [
    'github-status',
    String(postcondition.repository_id),
    postcondition.commit_sha,
    githubStatusContextKey(postcondition.context),
  ].join(':');
}

function leanPostcondition(postcondition:Postcondition):Record<string,unknown> {
  if (
    postcondition.verifier==='file-content-equals/v1'
    || postcondition.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    return {
      family:postcondition.verifier==='file-content-equals/v1'
        ? 'file-content'
        : 'eventually-consistent-file-content',
      verifier_revision:verifierRevision(postcondition),
      coordinate:postcondition.path,
      expected:sha256(postcondition.content),
    };
  }

  if (
    postcondition.verifier==='github-commit-status/v1'
    || postcondition.verifier==='github-commit-status/v2'
  ) {
    return {
      family:'github-commit-status',
      verifier_revision:verifierRevision(postcondition),
      coordinate:githubCoordinate(postcondition),
      expected:postcondition.expected_state,
    };
  }

  return {
    family:'kubernetes-configmap-exists',
    verifier_revision:verifierRevision(postcondition),
    coordinate:{
      authority_id:postcondition.authority_id,
      namespace:postcondition.namespace,
      name:postcondition.name,
    },
    expected:'exists',
  };
}

function data(value:unknown):Record<string,unknown>|null {
  return value && typeof value==='object' && !Array.isArray(value)
    ? value as Record<string,unknown>
    : null;
}

function localAbsence(evidence:AbsenceEvidenceCertificate):Record<string,unknown>|null {
  if (evidence.kind!=='local-file-enoent/v1') return null;
  const subject=data(evidence.subject);
  const scope=data(evidence.scope);
  const coordinate=data(scope?.coordinate);
  const completeness=data(evidence.completeness);
  const provenance=data(evidence.provenance);
  if (!subject || !coordinate || !completeness || !provenance) return null;
  return {
    kind:evidence.kind,
    subject_coordinate:subject.path,
    scope_coordinate:coordinate.path,
    snapshot_is_null:evidence.snapshot===null,
    completeness_kind:completeness.kind,
    completeness_result:completeness.result,
    provenance_adapter:provenance.adapter,
    provenance_operation:provenance.operation,
    provenance_error_code:provenance.error_code,
  };
}

function kubernetesAbsence(
  postcondition:Extract<Postcondition,{verifier:'kubernetes-configmap-exists/v1'}>,
  evidence:AbsenceEvidenceCertificate,
):Record<string,unknown>|null {
  if (evidence.kind!=='kubernetes-complete-list-absence/v1') return null;
  const snapshot=data(evidence.snapshot);
  const provenance=data(evidence.provenance);
  if (!snapshot || !provenance || !Array.isArray(provenance.pages)) return null;

  const pages:Record<string,unknown>[]=[];
  for (const raw of provenance.pages) {
    const page=data(raw);
    if (!page || !Array.isArray(page.members)) return null;
    const members=page.members.map(rawMember=>{
      const member=data(rawMember);
      if (!member) throw new Error('KUBERNETES_REALIZATION_MEMBER_INVALID');
      return {
        name:member.name,
        namespace:member.namespace,
        uid:member.uid,
        resource_version:member.resource_version,
      };
    });
    pages.push({
      authority_id:postcondition.authority_id,
      request_namespace:postcondition.namespace,
      request_continue:page.request_continue??null,
      response_continue:page.response_continue,
      snapshot_resource_version:page.snapshot_resource_version,
      members,
    });
  }

  return {
    kind:'kubernetes-complete-list-absence/v1',
    authority_id:postcondition.authority_id,
    namespace:postcondition.namespace,
    name:postcondition.name,
    snapshot_resource_version:snapshot.resource_version,
    pages,
  };
}

function leanObservation(
  postcondition:Postcondition,
  observation:Observation|null,
):Record<string,unknown>|null {
  if (!observation) return null;

  let actual:string|null=null;
  let absence:Record<string,unknown>|null=null;

  if (
    postcondition.verifier==='file-content-equals/v1'
    || postcondition.verifier==='eventually-consistent-file-content-equals/v1'
  ) {
    actual=typeof observation.actual_sha256==='string'
      ? observation.actual_sha256
      : null;
    if (observation.absence_evidence) {
      absence=localAbsence(observation.absence_evidence);
    }
  } else if (
    postcondition.verifier==='github-commit-status/v1'
    || postcondition.verifier==='github-commit-status/v2'
  ) {
    actual=typeof observation.actual_state==='string'
      ? observation.actual_state
      : null;
  } else {
    actual=observation.mutation_certainty==='present' ? 'exists' : null;
    if (observation.absence_evidence) {
      absence=kubernetesAbsence(postcondition,observation.absence_evidence);
    }
  }

  return {
    ...leanPostcondition(postcondition),
    certainty:observation.mutation_certainty,
    actual,
    absence,
  };
}

function runStatus(
  run:HistoricalRun,
  receiptsByRun:Map<string,Receipt>,
):LeanRun['status'] {
  const receipt=receiptsByRun.get(run.id);
  if (!receipt) return 'EXECUTING';
  return receipt.disposition;
}

function leanProject(
  postcondition:Postcondition,
  currentKey:string|null,
  runs:LeanRun[],
  observation:Observation|null,
):LeanProjection {
  const executable=process.env.OVERCENTER_LEAN_REALIZATION_PROJECTOR
    ??DEFAULT_PROJECTOR;
  try {
    const stdout=execFileSync(executable,[],{
      input:JSON.stringify({
        command:'realization-project',
        postcondition:leanPostcondition(postcondition),
        current_key:currentKey,
        runs,
        fresh_observation:leanObservation(postcondition,observation),
      }),
      encoding:'utf8',
      stdio:['pipe','pipe','pipe'],
    });
    const parsed=JSON.parse(stdout) as Partial<LeanProjection>;
    if (
      parsed.schema!=='overcenter-lean-realization-projection/v1'
      || !['UNREALIZED','EXECUTING','WAITING','RECOVERY_REQUIRED','DONE']
        .includes(String(parsed.lifecycle))
      || !('source_run_id' in parsed)
      || !('execution_run_id' in parsed)
    ) {
      throw new Error('INVALID_LEAN_REALIZATION_RESPONSE');
    }
    return parsed as LeanProjection;
  } catch (error:unknown) {
    const message=error instanceof Error?error.message:String(error);
    throw new Error(`LEAN_REALIZATION_PROJECTOR_FAILED:${message}`);
  }
}

export function observeCurrentSnapshot(
  state:State,
  observe:(postcondition:Postcondition)=>Observation,
):CurrentObservationSnapshot {
  return Object.fromEntries(
    Object.values(state.obligations)
      .sort((a,b)=>a.id.localeCompare(b.id))
      .map(work=>[work.id,observe(work.postcondition)]),
  );
}

export function validateCurrentObservationSnapshot(
  state:State,
  snapshot:unknown,
):asserts snapshot is CurrentObservationSnapshot {
  if (!snapshot || typeof snapshot!=='object' || Array.isArray(snapshot)) {
    throw new Error('INVALID_CURRENT_OBSERVATION_SNAPSHOT');
  }
  const record=snapshot as Record<string,unknown>;
  const expected=Object.keys(state.obligations).sort();
  const actual=Object.keys(record).sort();
  if (JSON.stringify(actual)!==JSON.stringify(expected)) {
    throw new Error('CURRENT_OBSERVATION_SNAPSHOT_COVERAGE_MISMATCH');
  }
  for (const id of expected) {
    const observation=record[id];
    if (!observation || typeof observation!=='object' || Array.isArray(observation)) {
      throw new Error(`INVALID_CURRENT_OBSERVATION:${id}`);
    }
  }
}

export function projectCurrentLifecycles(
  state:State,
  runs:Map<string,HistoricalRun>,
  receiptsByRun:Map<string,Receipt>,
  observations:CurrentObservationSnapshot,
):Map<string,CurrentLifecycle> {
  validateCurrentObservationSnapshot(state,observations);

  const projected=new Map<string,CurrentLifecycle>();
  const visiting=new Set<string>();
  const allRuns=[...runs.values()];

  const derive=(id:string):CurrentLifecycle=>{
    const known=projected.get(id);
    if (known) return known;
    if (visiting.has(id)) throw new Error(`DEPENDENCY_CYCLE:${id}`);
    visiting.add(id);

    const work=state.obligations[id];
    if (!work) throw new Error(`UNKNOWN_OBLIGATION:${id}`);

    for (const edge of work.dependencies) {
      if (edge.kind==='semantic') derive(edge.upstream);
    }

    const key=obligationKey(
      state,
      work,
      projected,
      receiptsByRun,
    );
    const workRuns=allRuns
      .filter(run=>run.obligation_id===id)
      .map(run=>({
        run_id:run.id,
        obligation_key:run.obligation_key,
        status:runStatus(run,receiptsByRun),
      }));

    const result=leanProject(
      work.postcondition,
      key,
      workRuns,
      observations[id]??null,
    );

    const sourceRun=result.source_run_id===null
      ? undefined
      : runs.get(result.source_run_id);
    const executionRun=result.execution_run_id===null
      ? undefined
      : runs.get(result.execution_run_id);

    if (result.source_run_id!==null && !sourceRun) {
      throw new Error('LEAN_REALIZATION_UNKNOWN_SOURCE_RUN');
    }
    if (result.execution_run_id!==null && !executionRun) {
      throw new Error('LEAN_REALIZATION_UNKNOWN_EXECUTION_RUN');
    }
    if (sourceRun?.obligation_id!==id || executionRun?.obligation_id!==id) {
      throw new Error('LEAN_REALIZATION_RUN_OBLIGATION_MISMATCH');
    }

    const lifecycle:CurrentLifecycle={
      status:result.lifecycle,
      ...(sourceRun?{sourceRun}:{}),
      ...(executionRun?{executionRun}:{}),
    };
    projected.set(id,lifecycle);
    visiting.delete(id);
    return lifecycle;
  };

  for (const id of Object.keys(state.obligations).sort()) derive(id);
  return projected;
}
