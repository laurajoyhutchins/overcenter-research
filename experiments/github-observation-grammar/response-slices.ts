import { githubResponseSlice } from '../../src/providers/github-semantics.ts';
import type { ResponseFieldSpec } from '../provider-observation/response-slice.ts';

function extend(
  operationId:string,
  ...extensions:readonly ResponseFieldSpec[]
):readonly ResponseFieldSpec[] {
  return [...githubResponseSlice(operationId),...extensions];
}

export const RESPONSE_SLICES = {
  'repos/get': githubResponseSlice('repos/get'),
  'git/get-ref': githubResponseSlice('git/get-ref'),
  'git/get-commit': githubResponseSlice('git/get-commit'),
  'pulls/get': githubResponseSlice('pulls/get'),
  'issues/get': extend('issues/get',{path:'pull_request',required:false}),
  'checks/list-for-ref': githubResponseSlice('checks/list-for-ref'),
  'repos/list-commit-statuses-for-ref': githubResponseSlice('repos/list-commit-statuses-for-ref'),
  'actions/list-workflow-runs-for-repo': extend(
    'actions/list-workflow-runs-for-repo',
    {path:'workflow_runs[].name'},
    {path:'workflow_runs[].event'},
  ),
} as const satisfies Record<string,readonly ResponseFieldSpec[]>;
