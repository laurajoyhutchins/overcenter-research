import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  GITHUB_COMMIT_STATUSES_OPERATION,
  GITHUB_COMPARE_COMMITS_OPERATION,
  GITHUB_OBSERVATION_OPERATIONS,
  GITHUB_PULL_REQUEST_OPERATION,
  GITHUB_REF_OPERATION,
  GITHUB_REPOSITORY_OPERATION,
} from '../src/providers/github-operations.generated.ts';
import { scanGithubPageCollection } from '../src/providers/github-page-collection.ts';
import { materializeGithubOperationRequest } from '../src/providers/github-openapi.ts';
import { GITHUB_OPERATION_SEMANTICS } from '../src/providers/github-semantics.ts';

test('generated GitHub operation catalog is bound to semantic operation IDs',()=>{
  assert.equal(GITHUB_REPOSITORY_OPERATION.operation_id,GITHUB_OPERATION_SEMANTICS.repository.operation_id);
  assert.equal(GITHUB_REF_OPERATION.operation_id,GITHUB_OPERATION_SEMANTICS.ref.operation_id);
  assert.equal(GITHUB_PULL_REQUEST_OPERATION.operation_id,GITHUB_OPERATION_SEMANTICS.pull_request.operation_id);
  assert.equal(GITHUB_COMMIT_STATUSES_OPERATION.operation_id,GITHUB_OPERATION_SEMANTICS.commit_statuses.operation_id);
  assert.equal(GITHUB_COMPARE_COMMITS_OPERATION.operation_id,GITHUB_OPERATION_SEMANTICS.compare_commits.operation_id);
  assert.equal(Object.keys(GITHUB_OPERATION_SEMANTICS).length,43);
  assert.deepEqual(
    Object.keys(GITHUB_OBSERVATION_OPERATIONS).sort(),
    Object.keys(GITHUB_OPERATION_SEMANTICS).sort(),
  );
  for (const [name,semantic] of Object.entries(GITHUB_OPERATION_SEMANTICS)) {
    const operation=GITHUB_OBSERVATION_OPERATIONS[name as keyof typeof GITHUB_OBSERVATION_OPERATIONS];
    assert.equal(operation.operation_id,semantic.operation_id);
    assert.equal(
      operation.github_extensions.enabledForGitHubApps,
      true,
      `registered observation is not callable by a GitHub App: ${semantic.operation_id}`,
    );
    assert.ok(
      semantic.required_permissions.length>0,
      `registered observation has no credential permission requirement: ${semantic.operation_id}`,
    );
  }
});

test('generated GitHub collection metadata captures page traversal defaults',()=>{
  assert.deepEqual(GITHUB_COMMIT_STATUSES_OPERATION.pagination,{
    kind:'page-number',
    page_parameter:'page',
    page_size_parameter:'per_page',
    first_page:1,
    default_page_size:30,
  });
  assert.equal(GITHUB_REPOSITORY_OPERATION.pagination,undefined);
});

test('GitHub request materialization is operation-driven',()=>{
  const request=materializeGithubOperationRequest(GITHUB_COMMIT_STATUSES_OPERATION,{
    owner:'acme',
    repo:'widget',
    ref:'heads/main',
    per_page:100,
    page:2,
  });
  assert.equal(request.path,'/repos/acme/widget/commits/heads%2Fmain/statuses?page=2&per_page=100');
  assert.deepEqual(request.parameters,{
    owner:'acme',
    ref:'heads/main',
    repo:'widget',
    page:2,
    per_page:100,
  });
  const compare=materializeGithubOperationRequest(GITHUB_COMPARE_COMMITS_OPERATION,{
    owner:'acme',
    repo:'widget',
    basehead:`${'a'.repeat(40)}...${'b'.repeat(40)}`,
  });
  assert.equal(
    compare.path,
    `/repos/acme/widget/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`,
  );
  assert.throws(
    ()=>materializeGithubOperationRequest(GITHUB_REF_OPERATION,{owner:'acme',repo:'widget'}),
    /GITHUB_OPERATION_PARAMETER_REQUIRED:ref/,
  );
  assert.throws(
    ()=>materializeGithubOperationRequest(GITHUB_REF_OPERATION,{owner:'acme',repo:'widget',ref:'heads\/main',surprise:true}),
    /GITHUB_OPERATION_PARAMETER_UNKNOWN:surprise/,
  );
});

test('certified providers do not copy GitHub routes or response schemas',()=>{
  for (const path of [
    'src/providers/github-certified-repository.ts',
    'src/providers/github-certified-read.ts',
    'src/providers/github-certified-observation.ts',
    'src/providers/github-certified-ancestry.ts',
    'src/providers/github-certified-ref.ts',
    'src/providers/github-certified-pr.ts',
    'src/providers/github-certified-status.ts',
  ]) {
    const source=readFileSync(path,'utf8');
    assert.doesNotMatch(source,/path_template\s*:\s*['\"`]/,path);
    assert.doesNotMatch(source,/outcomes\s*:\s*\[/,path);
    assert.doesNotMatch(source,/['\"`]\/repos\//,path);
  }
});

test('page collection traversal is driven by generated operation metadata',()=>{
  const seen:string[]=[];
  const first=Array.from({length:30},(_,index)=>index);
  const result=scanGithubPageCollection({
    operation:GITHUB_COMMIT_STATUSES_OPERATION,
    parameters:{owner:'acme',repo:'widget',ref:'abc'},
    readPage:({request,page})=>{
      seen.push(request.path);
      return {
        members:page===1?first:[31],
        evidence:{observed_at:`page-${page}`},
      };
    },
    matches:member=>member===31,
  });

  assert.equal(result.state,'matched');
  assert.deepEqual(seen,[
    '/repos/acme/widget/commits/abc/statuses?page=1&per_page=30',
    '/repos/acme/widget/commits/abc/statuses?page=2&per_page=30',
  ]);
  assert.equal(result.pages.length,2);
  assert.equal(result.pages[0].member_count,30);
  assert.equal(result.pages[1].member_count,1);
});

test('page collection traversal fails closed on unsupported or hostile shapes',()=>{
  assert.throws(
    ()=>scanGithubPageCollection({
      operation:GITHUB_REPOSITORY_OPERATION,
      parameters:{owner:'acme',repo:'widget'},
      readPage:()=>({members:[],evidence:{}}),
      matches:()=>false,
    }),
    /GITHUB_OPERATION_PAGE_PAGINATION_UNAVAILABLE:repos\/get/,
  );

  assert.throws(
    ()=>scanGithubPageCollection({
      operation:GITHUB_COMMIT_STATUSES_OPERATION,
      parameters:{owner:'acme',repo:'widget',ref:'abc',page:7},
      readPage:()=>({members:[],evidence:{}}),
      matches:()=>false,
    }),
    /GITHUB_PAGE_SCAN_PAGINATION_PARAMETER_RESERVED/,
  );

  assert.throws(
    ()=>scanGithubPageCollection({
      operation:GITHUB_COMMIT_STATUSES_OPERATION,
      parameters:{owner:'acme',repo:'widget',ref:'abc'},
      readPage:()=>({members:Array.from({length:31},(_,index)=>index),evidence:{}}),
      matches:()=>false,
    }),
    /GITHUB_PAGE_SCAN_PAGE_OVERSIZED/,
  );

  const ended=scanGithubPageCollection({
    operation:GITHUB_COMMIT_STATUSES_OPERATION,
    parameters:{owner:'acme',repo:'widget',ref:'abc'},
    readPage:()=>({members:[],evidence:{}}),
    matches:()=>false,
  });
  assert.equal(ended.state,'collection-end-observed');
  assert.equal(ended.pages.length,1);

  const limited=scanGithubPageCollection({
    operation:GITHUB_COMMIT_STATUSES_OPERATION,
    parameters:{owner:'acme',repo:'widget',ref:'abc'},
    maxPages:2,
    readPage:()=>({
      members:Array.from({length:30},(_,index)=>index),
      evidence:{},
    }),
    matches:()=>false,
  });
  assert.equal(limited.state,'limit-reached');
  assert.equal(limited.pages.length,2);
});

test('certified status verifier contains no GitHub page-parameter convention',()=>{
  const source=readFileSync('src/providers/github-certified-status.ts','utf8');
  assert.doesNotMatch(source,/per_page/);
  assert.doesNotMatch(source,/default_page_size/);
  assert.equal(source.includes('page='),false);
  assert.equal(source.includes('for (let page'),false);
});


test('live observation workflow grants every permission required by registered semantic reads',()=>{
  const workflow=readFileSync('.github/workflows/github-observation-grammar.yml','utf8');
  const yamlName:Record<string,string>={
    actions:'actions',
    checks:'checks',
    contents:'contents',
    deployments:'deployments',
    issues:'issues',
    pull_requests:'pull-requests',
    statuses:'statuses',
  };
  const required=new Set(
    Object.values(GITHUB_OPERATION_SEMANTICS)
      .flatMap(semantic=>semantic.required_permissions),
  );
  for(const permission of required){
    const [name,level]=permission.split(':');
    assert.match(
      workflow,
      new RegExp(`^  ${yamlName[name]}: ${level}$`,'m'),
      `workflow credential profile does not grant ${permission}`,
    );
  }
});
