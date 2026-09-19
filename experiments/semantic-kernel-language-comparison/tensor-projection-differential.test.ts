import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import test from 'node:test';

import {canonicalStringCompare} from '../../src/digest.ts';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterGraphTensor';
const python='experiments/semantic-kernel-language-comparison/typed-tensor-two-hop.py';

type Relation=
  |'control'
  |'semantic-verified-content'
  |'semantic-settlement-receipt';

type Dependency={
  upstream:string;
  kind:'control'|'semantic';
  selector:null|'verified-content'|'settlement-receipt';
};

type Obligation={id:string;dependencies:Dependency[]};

type Context={
  current_revision:string;
  expected_revision:string;
  target_id:string;
  obligations:Obligation[];
  lifecycles:Array<{
    obligation_id:string;
    status:'UNREALIZED';
    run_id:null;
  }>;
};

type TensorProjection={
  schema:'overcenter-lean-graph-tensor/v1';
  view_key:string;
  node_ids:string[];
  relation_names:Relation[];
  edge_index:Array<[number,number]>;
  edge_type:number[];
};

type Proposal={
  source:string;
  target:string;
  left_relation:Relation;
  right_relation:Relation;
};

const control=(upstream:string):Dependency=>({
  upstream,kind:'control',selector:null,
});
const verified=(upstream:string):Dependency=>({
  upstream,kind:'semantic',selector:'verified-content',
});
const receipt=(upstream:string):Dependency=>({
  upstream,kind:'semantic',selector:'settlement-receipt',
});

function context(obligations:Obligation[],target_id=obligations[0]?.id??'missing'):Context {
  return {
    current_revision:'r1',
    expected_revision:'r1',
    target_id,
    obligations,
    lifecycles:obligations.map(item=>({
      obligation_id:item.id,
      status:'UNREALIZED' as const,
      run_id:null,
    })),
  };
}

function project(input:Context):TensorProjection {
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify({command:'tensor-project',...input}),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  const result=JSON.parse(stdout) as TensorProjection;
  assert.equal(result.schema,'overcenter-lean-graph-tensor/v1');
  return result;
}

function projectFailure(input:Context):ReturnType<typeof spawnSync> {
  return spawnSync(kernel,[],{
    input:JSON.stringify({command:'tensor-project',...input}),
    encoding:'utf8',
  });
}

function relation(dep:Dependency):Relation {
  if (dep.kind==='control') return 'control';
  if (dep.selector==='verified-content') return 'semantic-verified-content';
  if (dep.selector==='settlement-receipt') return 'semantic-settlement-receipt';
  throw new Error('invalid dependency');
}

const relationNames:Relation[]=[
  'control',
  'semantic-verified-content',
  'semantic-settlement-receipt',
];

function directProjection(input:Context):{
  node_ids:string[];
  edge_index:Array<[number,number]>;
  edge_type:number[];
} {
  const node_ids=input.obligations.map(item=>item.id)
    .sort(canonicalStringCompare);
  const index=new Map(node_ids.map((id,offset)=>[id,offset]));
  const edges=input.obligations.flatMap(item=>
    item.dependencies.map(dep=>({
      source:item.id,
      target:dep.upstream,
      relation:relation(dep),
    })),
  ).sort((left,right)=>canonicalStringCompare(
    JSON.stringify([left.source,left.relation,left.target]),
    JSON.stringify([right.source,right.relation,right.target]),
  ));
  return {
    node_ids,
    edge_index:edges.map(edge=>[
      index.get(edge.source)!,
      index.get(edge.target)!,
    ]),
    edge_type:edges.map(edge=>relationNames.indexOf(edge.relation)),
  };
}

function directTwoHop(input:Context):Proposal[] {
  const edges=input.obligations.flatMap(item=>
    item.dependencies.map(dep=>({
      source:item.id,
      target:dep.upstream,
      relation:relation(dep),
    })),
  );
  const proposals:Proposal[]=[];
  for (const left of edges) {
    for (const right of edges) {
      if (left.target!==right.source) continue;
      proposals.push({
        source:left.source,
        target:right.target,
        left_relation:left.relation,
        right_relation:right.relation,
      });
    }
  }
  return [...new Map(proposals.map(item=>[
    JSON.stringify(item),item,
  ])).values()].sort((a,b)=>canonicalStringCompare(
    JSON.stringify(a),JSON.stringify(b),
  ));
}

function pythonTwoHop(projection:TensorProjection):{
  schema:string;
  view_key:string;
  proposals:Proposal[];
} {
  const stdout=execFileSync('python3',[python],{
    input:JSON.stringify(projection),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  return JSON.parse(stdout) as {
    schema:string;
    view_key:string;
    proposals:Proposal[];
  };
}

function verify(
  input:Context,
  projection:TensorProjection,
  proposal:Proposal,
):{accepted:boolean;reason:string} {
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify({
      command:'tensor-verify-two-hop',
      ...input,
      view_key:projection.view_key,
      ...proposal,
    }),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  return JSON.parse(stdout) as {accepted:boolean;reason:string};
}

const base=context([
  {id:'c',dependencies:[]},
  {id:'b',dependencies:[control('c')]},
  {id:'a',dependencies:[verified('b'),receipt('b')]},
]);

test('Lean tensor projection agrees with direct graph structure',()=>{
  const lean=project(base);
  const direct=directProjection(base);
  assert.deepEqual(lean.node_ids,direct.node_ids);
  assert.deepEqual(lean.edge_index,direct.edge_index);
  assert.deepEqual(lean.edge_type,direct.edge_type);
  assert.deepEqual(lean.relation_names,relationNames);
});

test('declaration order and Unicode ids do not change canonical projection',()=>{
  const first=context([
    {id:'😀',dependencies:[control('a')]},
    {id:'\uE000',dependencies:[]},
    {id:'a',dependencies:[verified('\uE000')]},
  ],'😀');
  const second=context([
    {id:'a',dependencies:[verified('\uE000')]},
    {id:'\uE000',dependencies:[]},
    {id:'😀',dependencies:[control('a')]},
  ],'😀');
  second.obligations[2].dependencies=[...second.obligations[2].dependencies].reverse();

  assert.deepEqual(project(first),project(second));
  assert.deepEqual(
    project(first).node_ids,
    ['😀','\uE000','a'].sort(canonicalStringCompare),
  );
});

test('typed relations remain distinct for identical endpoints',()=>{
  const input=context([
    {id:'b',dependencies:[]},
    {id:'a',dependencies:[control('b'),verified('b'),receipt('b')]},
  ]);
  const projection=project(input);
  assert.equal(projection.edge_index.length,3);
  assert.deepEqual(new Set(projection.edge_type),new Set([0,1,2]));
});

test('exact duplicate dependencies fail closed',()=>{
  const input=context([
    {id:'b',dependencies:[]},
    {id:'a',dependencies:[verified('b'),verified('b')]},
  ]);
  const result=projectFailure(input);
  assert.equal(result.status,2);
  assert.match(result.stderr,/not projectable/i);
});

test('unknown references fail closed but cycles remain representable',()=>{
  const unknown=context([
    {id:'a',dependencies:[control('missing')]},
  ]);
  assert.equal(projectFailure(unknown).status,2);

  const cycle=context([
    {id:'a',dependencies:[control('b')]},
    {id:'b',dependencies:[control('a')]},
  ]);
  assert.equal(project(cycle).edge_index.length,2);
});

test('Python tensor multiplication and direct traversal produce the same typed two-hop facts',()=>{
  const projection=project(base);
  const pythonResult=pythonTwoHop(projection);
  assert.equal(pythonResult.schema,'overcenter-python-two-hop/v1');
  assert.equal(pythonResult.view_key,projection.view_key);
  assert.deepEqual(pythonResult.proposals,directTwoHop(base));

  for (const proposal of pythonResult.proposals) {
    assert.deepEqual(
      verify(base,projection,proposal),
      {accepted:true,reason:'verified'},
    );
  }
});

test('Python consumer rejects forged tensor coordinates and relation codes',()=>{
  const projection=project(base);
  const badIndex=structuredClone(projection);
  badIndex.edge_index[0]=[999,0];
  const indexResult=spawnSync('python3',[python],{
    input:JSON.stringify(badIndex),
    encoding:'utf8',
  });
  assert.notEqual(indexResult.status,0);
  assert.match(indexResult.stderr,/outside node range/i);

  const badRelation=structuredClone(projection);
  badRelation.edge_type[0]=999;
  const relationResult=spawnSync('python3',[python],{
    input:JSON.stringify(badRelation),
    encoding:'utf8',
  });
  assert.notEqual(relationResult.status,0);
  assert.match(relationResult.stderr,/unknown relation type/i);
});

test('Lean rejects nonexistent and stale Python proposals',()=>{
  const projection=project(base);
  assert.deepEqual(
    verify(base,projection,{
      source:'a',
      target:'c',
      left_relation:'control',
      right_relation:'control',
    }),
    {accepted:false,reason:'no-path'},
  );

  const changed=context([
    {id:'c',dependencies:[]},
    {id:'b',dependencies:[receipt('c')]},
    {id:'a',dependencies:[verified('b'),receipt('b')]},
  ]);
  const stale=verify(changed,projection,{
    source:'a',
    target:'c',
    left_relation:'semantic-verified-content',
    right_relation:'control',
  });
  assert.deepEqual(stale,{accepted:false,reason:'stale-view'});
});

test('serialized projection boundary rejects caller supplied tensor claims',()=>{
  for (const field of [
    'view_key','node_ids','edge_index','edge_type','relation_names',
  ]) {
    const result=spawnSync(kernel,[],{
      input:JSON.stringify({
        command:'tensor-project',
        ...base,
        [field]:field==='view_key'?'forged':[],
      }),
      encoding:'utf8',
    });
    assert.equal(result.status,2,field);
    assert.match(result.stderr,/forbidden/i,field);
  }
});
