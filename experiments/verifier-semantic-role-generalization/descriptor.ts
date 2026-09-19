import type { Observation, Postcondition } from '../../src/model.ts';
import { canonicalDigest, sha256 } from '../../src/digest.ts';
import { LOCAL_FILE_ENOENT_EVIDENCE } from '../../src/evidence.ts';
import {
  KUBERNETES_COMPLETE_LIST_ABSENCE,
} from '../../src/providers/kubernetes-configmap.ts';
import {
  githubRepositoryFullNameKey,
  githubStatusContextKey,
} from '../../src/providers/github-rest.ts';

export type FieldRole =
  | 'authority'
  | 'resource'
  | 'target'
  | 'desired'
  | 'output'
  | 'observation-alias';

export type Normalizer =
  | 'identity'
  | 'github-status-context'
  | 'github-repository-full-name';

export interface FieldSemantics {
  field:string;
  roles:readonly FieldRole[];
  observation?:Normalizer;
  semantic?:Normalizer;
}

export interface VerifierDescriptor {
  provider?:'github'|'kubernetes';
  fields:readonly FieldSemantics[];
  output:
    | {kind:'value-sha256'}
    | {
        kind:'subject-state';
        state:{kind:'output-field'}|{kind:'constant';value:string};
      };
  effect:
    | {kind:'none'}
    | {kind:'subject';prefix:string;sameDesiredCommutes:boolean};
  absence:
    | {kind:'none'}
    | {
        kind:'subject-scope';
        evidenceKind:string;
        scope:'subject'|'container';
        shape:'flat'|'file-exact';
      };
}

const fileFields=[
  {field:'path',roles:['target']},
  {field:'content',roles:['desired','output']},
] as const satisfies readonly FieldSemantics[];

const githubStatusFields=[
  {field:'repository_id',roles:['authority']},
  {field:'commit_sha',roles:['resource']},
  {
    field:'context',
    roles:['resource'],
    semantic:'github-status-context',
  },
  {field:'expected_state',roles:['desired','output']},
] as const satisfies readonly FieldSemantics[];

export const verifierSemanticDescriptors={
  'file-content-equals/v1':{
    fields:fileFields,
    output:{kind:'value-sha256'},
    effect:{kind:'none'},
    absence:{
      kind:'subject-scope',
      evidenceKind:LOCAL_FILE_ENOENT_EVIDENCE,
      scope:'subject',
      shape:'file-exact',
    },
  },
  'eventually-consistent-file-content-equals/v1':{
    fields:fileFields,
    output:{kind:'value-sha256'},
    effect:{kind:'none'},
    absence:{kind:'none'},
  },
  'github-commit-status/v1':{
    provider:'github',
    fields:githubStatusFields,
    output:{kind:'subject-state',state:{kind:'output-field'}},
    effect:{kind:'subject',prefix:'github-status',sameDesiredCommutes:true},
    absence:{kind:'none'},
  },
  'github-commit-status/v2':{
    provider:'github',
    fields:[
      ...githubStatusFields,
      {
        field:'repository_full_name',
        roles:['observation-alias'],
        observation:'github-repository-full-name',
      },
    ],
    output:{kind:'subject-state',state:{kind:'output-field'}},
    effect:{kind:'subject',prefix:'github-status',sameDesiredCommutes:true},
    absence:{kind:'none'},
  },
  'kubernetes-configmap-exists/v1':{
    provider:'kubernetes',
    fields:[
      {field:'authority_id',roles:['authority']},
      {field:'api_group',roles:['resource']},
      {field:'resource',roles:['resource']},
      {field:'namespace',roles:['resource']},
      {field:'name',roles:['target']},
    ],
    output:{kind:'subject-state',state:{kind:'constant',value:'exists'}},
    effect:{kind:'none'},
    absence:{
      kind:'subject-scope',
      evidenceKind:KUBERNETES_COMPLETE_LIST_ABSENCE,
      scope:'container',
      shape:'flat',
    },
  },
} as const satisfies Record<Postcondition['verifier'],VerifierDescriptor>;

function descriptor(postcondition:Postcondition):VerifierDescriptor {
  return verifierSemanticDescriptors[postcondition.verifier];
}

function normalize(value:unknown,normalizer:Normalizer='identity'):unknown {
  if (normalizer==='github-status-context') {
    return typeof value==='string' ? githubStatusContextKey(value) : value;
  }
  if (normalizer==='github-repository-full-name') {
    return typeof value==='string' ? githubRepositoryFullNameKey(value) : value;
  }
  return value;
}

function hasRole(field:FieldSemantics,role:FieldRole):boolean {
  return field.roles.includes(role);
}

function semanticSubject(
  postcondition:Postcondition,
  includeTarget=true,
):Record<string,unknown> {
  const spec=descriptor(postcondition);
  const subject:Record<string,unknown>={};
  if (spec.provider) subject.provider=spec.provider;
  for (const field of spec.fields) {
    const included=hasRole(field,'authority')
      || hasRole(field,'resource')
      || (includeTarget && hasRole(field,'target'));
    if (!included) continue;
    subject[field.field]=normalize(
      (postcondition as unknown as Record<string,unknown>)[field.field],
      field.semantic,
    );
  }
  return subject;
}

function singleRoleField(
  postcondition:Postcondition,
  role:'desired'|'output',
):FieldSemantics {
  const fields=descriptor(postcondition).fields.filter(field=>hasRole(field,role));
  if (fields.length!==1) {
    throw new Error(`EXPECTED_ONE_${role.toUpperCase()}_FIELD`);
  }
  return fields[0];
}

function singleRoleValue(
  postcondition:Postcondition,
  role:'desired'|'output',
):unknown {
  const field=singleRoleField(postcondition,role);
  return normalize(
    (postcondition as unknown as Record<string,unknown>)[field.field],
    field.semantic,
  );
}

export function descriptorObservationMatches(
  postcondition:Postcondition,
  observed:Observation,
):boolean {
  const spec=descriptor(postcondition);
  if (observed.verifier!==postcondition.verifier) return false;
  if (spec.provider && observed.provider!==spec.provider) return false;
  const source=postcondition as unknown as Record<string,unknown>;
  const target=observed as unknown as Record<string,unknown>;
  for (const field of spec.fields) {
    if (!(
      hasRole(field,'authority')
      || hasRole(field,'resource')
      || hasRole(field,'target')
      || hasRole(field,'observation-alias')
    )) continue;
    if (
      normalize(target[field.field],field.observation)
      !==normalize(source[field.field],field.observation)
    ) return false;
  }
  return true;
}

export function descriptorVerifiedContentIdentity(
  postcondition:Postcondition,
):string {
  const spec=descriptor(postcondition);
  if (spec.output.kind==='value-sha256') {
    const value=singleRoleValue(postcondition,'output');
    if (typeof value!=='string') throw new Error('OUTPUT_VALUE_NOT_STRING');
    return `sha256:${sha256(value)}`;
  }
  const state=spec.output.state.kind==='constant'
    ? spec.output.state.value
    : singleRoleValue(postcondition,'output');
  return canonicalDigest({...semanticSubject(postcondition),state});
}

export function descriptorEffectSemantics(postcondition:Postcondition):{
  resource:string;
  desired:string;
  sameDesiredCommutes:boolean;
}|null {
  const spec=descriptor(postcondition);
  if (spec.effect.kind==='none') return null;
  const source=postcondition as unknown as Record<string,unknown>;
  const parts=spec.fields
    .filter(field=>(
      hasRole(field,'authority')
      || hasRole(field,'resource')
      || hasRole(field,'target')
    ))
    .map(field=>normalize(source[field.field],field.semantic));
  const desired=singleRoleValue(postcondition,'desired');
  if (typeof desired!=='string') throw new Error('DESIRED_VALUE_NOT_STRING');
  return {
    resource:[spec.effect.prefix,...parts].join(':'),
    desired,
    sameDesiredCommutes:spec.effect.sameDesiredCommutes,
  };
}

export function descriptorSettlementSemantics(postcondition:Postcondition):{
  verifier:Postcondition['verifier'];
  acceptedAbsenceEvidenceKinds:readonly string[];
} {
  const absence=descriptor(postcondition).absence;
  return {
    verifier:postcondition.verifier,
    acceptedAbsenceEvidenceKinds:absence.kind==='none'
      ? []
      : [absence.evidenceKind],
  };
}

export function descriptorAbsenceBinding(postcondition:Postcondition):{
  kind:string;
  subject:Record<string,unknown>;
  scope:Record<string,unknown>;
}|null {
  const absence=descriptor(postcondition).absence;
  if (absence.kind==='none') return null;
  if (absence.shape==='file-exact') {
    const path=(postcondition as unknown as Record<string,unknown>).path;
    return {
      kind:absence.evidenceKind,
      subject:{kind:'file-path',path},
      scope:{kind:'exact-coordinate',coordinate:{kind:'file-path',path}},
    };
  }
  const subject=semanticSubject(postcondition);
  return {
    kind:absence.evidenceKind,
    subject,
    scope:absence.scope==='subject'
      ? subject
      : semanticSubject(postcondition,false),
  };
}
