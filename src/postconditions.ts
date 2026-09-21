import type { Postcondition } from './model.ts';
import { isGithubObjectId } from './providers/github-rest.ts';

export const POSTCONDITION_VERIFIERS=[
  'file-content-equals/v1',
  'eventually-consistent-file-content-equals/v1',
  'github-commit-status/v2',
  'kubernetes-configmap-exists/v1',
] as const;

function data(value:unknown):value is Record<string,unknown> {
  return !!value && typeof value==='object' && !Array.isArray(value);
}

function exactKeys(
  value:Record<string,unknown>,
  required:readonly string[],
  optional:readonly string[]=[],
):void {
  const allowed=new Set([...required,...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`POSTCONDITION_UNKNOWN_FIELD:${key}`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new Error(`POSTCONDITION_MISSING_FIELD:${key}`);
    }
  }
}

function nonEmptyNoNul(value:unknown,error:string):asserts value is string {
  if (
    typeof value!=='string'
    || value.length===0
    || value.includes('\0')
  ) throw new Error(error);
}

export function validatePostcondition(p:Postcondition):void {
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

export function validateCanonicalPostcondition(
  value:unknown,
):asserts value is Postcondition {
  if (!data(value)) throw new Error('INVALID_POSTCONDITION');

  switch (value.verifier) {
    case 'file-content-equals/v1':
    case 'eventually-consistent-file-content-equals/v1':
      exactKeys(value,['verifier','path','content']);
      nonEmptyNoNul(value.path,'INVALID_POSTCONDITION_PATH');
      if (typeof value.content!=='string') {
        throw new Error('INVALID_POSTCONDITION_CONTENT');
      }
      break;
    case 'github-commit-status/v2':
      exactKeys(value,[
        'verifier',
        'provider',
        'repository_id',
        'repository_full_name',
        'commit_sha',
        'context',
        'expected_state',
      ]);
      nonEmptyNoNul(
        value.repository_full_name,
        'INVALID_POSTCONDITION_REPOSITORY_FULL_NAME',
      );
      if (!/^[^/\0]+\/[^/\0]+$/.test(value.repository_full_name)) {
        throw new Error('INVALID_POSTCONDITION_REPOSITORY_FULL_NAME');
      }
      break;
    case 'kubernetes-configmap-exists/v1':
      exactKeys(value,[
        'verifier',
        'provider',
        'authority_id',
        'api_group',
        'resource',
        'namespace',
        'name',
      ]);
      nonEmptyNoNul(value.authority_id,'INVALID_POSTCONDITION_AUTHORITY_ID');
      nonEmptyNoNul(value.namespace,'INVALID_POSTCONDITION_NAMESPACE');
      nonEmptyNoNul(value.name,'INVALID_POSTCONDITION_NAME');
      break;
    default:
      throw new Error('UNSUPPORTED_POSTCONDITION');
  }

  validatePostcondition(value as unknown as Postcondition);

  if (value.verifier==='github-commit-status/v2') {
    nonEmptyNoNul(value.context,'INVALID_POSTCONDITION_CONTEXT');
  }
}
