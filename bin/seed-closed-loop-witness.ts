import {readFileSync} from 'node:fs';

import {GITHUB_AGENT_AUTHORITY_REF} from '../src/github-agent-authority.ts';
import {GitOvercenterKernel} from '../src/git-kernel.ts';
import {
  AGENT_AUTHORIZATION_POLICY,
} from '../src/project-advance.ts';
import {GITHUB_COMMIT_STATUS_EFFECT} from '../src/providers/github-status-effect.ts';

const SEED_PATH='experiments/closed-loop-actions/seed.json';

function required(name:string):string {
  const value=process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function positiveInteger(name:string):number {
  const value=Number(required(name));
  if (!Number.isSafeInteger(value) || value<=0) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

const sourceSha=required('SOURCE_SHA').toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('SOURCE_SHA_INVALID');

const seed=JSON.parse(readFileSync(SEED_PATH,'utf8')) as Record<string,unknown>;
if (seed.schema!=='overcenter-closed-loop-seed/v1') {
  throw new Error('CLOSED_LOOP_SEED_SCHEMA_INVALID');
}
if (seed.execution_policy!==AGENT_AUTHORIZATION_POLICY) {
  throw new Error('CLOSED_LOOP_SEED_EXECUTION_POLICY_INVALID');
}
if (seed.effect_contract!==GITHUB_COMMIT_STATUS_EFFECT) {
  throw new Error('CLOSED_LOOP_SEED_EFFECT_CONTRACT_INVALID');
}
for (const key of ['obligation_id','status_context'] as const) {
  if (typeof seed[key]!=='string' || seed[key].length===0) {
    throw new Error(`CLOSED_LOOP_SEED_${key.toUpperCase()}_INVALID`);
  }
}

const repositoryFullName=required('REPOSITORY_FULL_NAME');
if (!/^[^/\s]+\/[^/\s]+$/.test(repositoryFullName)) {
  throw new Error('REPOSITORY_FULL_NAME_INVALID');
}

const kernel=new GitOvercenterKernel(process.cwd(),{
  remote:'origin',
  ref:GITHUB_AGENT_AUTHORITY_REF,
});
kernel.initialize();

const desired={
  id:String(seed.obligation_id),
  packet:{
    execution_policy:AGENT_AUTHORIZATION_POLICY,
    effect_contract:GITHUB_COMMIT_STATUS_EFFECT,
    purpose:'hosted-agent-authorization-witness',
  },
  postcondition:{
    verifier:'github-commit-status/v2' as const,
    provider:'github' as const,
    repository_id:positiveInteger('REPOSITORY_ID'),
    repository_full_name:repositoryFullName,
    commit_sha:sourceSha,
    context:String(seed.status_context),
    expected_state:'success' as const,
  },
};

const before=kernel.head();
if (!before) throw new Error('CLOSED_LOOP_AUTHORITY_UNINITIALIZED');
const result=kernel.reconcileGraph([desired],before);
console.log(JSON.stringify({
  schema:'overcenter-closed-loop-seed-result/v1',
  authority_ref:GITHUB_AGENT_AUTHORITY_REF,
  source_sha:sourceSha,
  ...result,
}));
