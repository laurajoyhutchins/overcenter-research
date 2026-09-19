import type { ResponseFieldSpec } from '../provider-observation/response-slice.ts';

export interface GithubSemanticOperation {
  operation_id:string;
  response_slice:readonly ResponseFieldSpec[];
}

export const GITHUB_OPERATION_SEMANTICS={
  repository:{
    operation_id:'repos/get',
    response_slice:[
      {path:'id'},
      {path:'node_id'},
      {path:'full_name'},
      {path:'name'},
      {path:'owner.login'},
    ],
  },
  ref:{
    operation_id:'git/get-ref',
    response_slice:[
      {path:'ref'},
      {path:'object.type'},
      {path:'object.sha'},
    ],
  },
  pull_request:{
    operation_id:'pulls/get',
    response_slice:[
      {path:'id'},
      {path:'node_id'},
      {path:'number'},
      {path:'state'},
      {path:'head.sha'},
      {path:'base.ref'},
      {path:'base.sha'},
    ],
  },
  commit_statuses:{
    operation_id:'repos/list-commit-statuses-for-ref',
    response_slice:[
      {path:'[].id'},
      {path:'[].node_id'},
      {path:'[].state'},
      {path:'[].context'},
      {path:'[].target_url'},
      {path:'[].created_at'},
      {path:'[].updated_at'},
    ],
  },
} as const satisfies Record<string,GithubSemanticOperation>;

export const GITHUB_REPOSITORY_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.repository.response_slice;
export const GITHUB_REF_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.ref.response_slice;
export const GITHUB_PULL_REQUEST_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.pull_request.response_slice;
export const GITHUB_COMMIT_STATUS_RESPONSE_SLICE=GITHUB_OPERATION_SEMANTICS.commit_statuses.response_slice;
