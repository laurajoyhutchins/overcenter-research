import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  observeCertifiedKubernetesConfigMap,
} from '../src/providers/kubernetes-configmap.ts';
import type { KubernetesConfigMapExistsPostcondition } from '../src/model.ts';
import { kubernetesListFromGoTrace, type GoKubernetesListTrace } from '../experiments/kubernetes-go-observer/adapter.ts';

const execFileAsync=promisify(execFile);
const experimentDir=fileURLToPath(new URL('../experiments/kubernetes-go-observer/',import.meta.url));
const AUTHORITY='kind:go-observer-test';
const SCHEMA_SHA='a'.repeat(64);

const operation={
  operation_id:KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  outcomes:[{
    status:'200',
    schema:{
      type:'object',
      required:['apiVersion','kind','metadata','items'],
      properties:{
        apiVersion:{type:'string'},
        kind:{type:'string'},
        metadata:{
          type:'object',
          required:['resourceVersion'],
          properties:{
            resourceVersion:{type:'string'},
            continue:{type:'string'},
          },
        },
        items:{
          type:'array',
          items:{
            type:'object',
            required:['metadata'],
            properties:{
              metadata:{
                type:'object',
                required:['name','namespace','uid','resourceVersion'],
                properties:{
                  name:{type:'string'},
                  namespace:{type:'string'},
                  uid:{type:'string'},
                  resourceVersion:{type:'string'},
                },
              },
            },
          },
        },
      },
    },
  }],
};

function pc():KubernetesConfigMapExistsPostcondition {
  return {
    verifier:'kubernetes-configmap-exists/v1',
    provider:'kubernetes',
    authority_id:AUTHORITY,
    api_group:'',
    resource:'configmaps',
    namespace:'proof',
    name:'target',
  };
}

function body(
  rv:string,
  next:string,
  items:Array<{name:string;namespace?:string;uid:string;resourceVersion:string}>=[],
) {
  return {
    apiVersion:'v1',
    kind:'ConfigMapList',
    metadata:{resourceVersion:rv,continue:next},
    items:items.map(item=>({
      metadata:{
        ...item,
        namespace:item.namespace??'proof',
      },
    })),
  };
}

async function listen(
  handler:Parameters<typeof createServer>[0],
):Promise<{server:Server;baseUrl:string}> {
  const server=createServer(handler);
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>resolve());
  });
  const address=server.address();
  assert.ok(address && typeof address==='object');
  return {server,baseUrl:`http://127.0.0.1:${address.port}`};
}

async function collect(baseUrl:string):Promise<GoKubernetesListTrace> {
  const {stdout}=await execFileAsync('go',[
    'run','./cmd/kube-list-trace',
    '--base-url',baseUrl,
    '--authority-id',AUTHORITY,
    '--namespace','proof',
    '--limit','1',
  ],{cwd:experimentDir,maxBuffer:8*1024*1024});
  return JSON.parse(stdout) as GoKubernetesListTrace;
}

function verify(trace:GoKubernetesListTrace) {
  return observeCertifiedKubernetesConfigMap(pc(),{
    list:kubernetesListFromGoTrace(trace,{
      operation,
      schemaSha256:SCHEMA_SHA,
    }),
    limit:1,
  });
}

test('Go acquires a paginated trace; the existing verifier alone mints absence or presence',async()=>{
  let present=false;
  let baseUrl='';
  const {server,baseUrl:resolvedBaseUrl}=await listen((request,response)=>{
    const url=new URL(request.url!,baseUrl);
    response.setHeader('content-type','application/json');
    const token=url.searchParams.get('continue');
    if (present) {
      response.end(JSON.stringify(body('600','',[{
        name:'target',uid:'uid-target',resourceVersion:'599',
      }])));
      return;
    }
    response.end(JSON.stringify(
      token===null
        ? body('500','token-1',[{name:'distractor',uid:'uid-d',resourceVersion:'499'}])
        : body('500',''),
    ));
  });
  baseUrl=resolvedBaseUrl;
  try {
    const absent=verify(await collect(baseUrl));
    assert.equal(absent.state,'absent');
    assert.equal(absent.absence_evidence?.completeness.page_count,2);

    present=true;
    const found=verify(await collect(baseUrl));
    assert.equal(found.state,'present');
    assert.equal(found.uid,'uid-target');
  } finally {
    server.close();
  }
});

test('Go preserves resourceVersion drift; TypeScript rejects it semantically',async()=>{
  let baseUrl='';
  const {server,baseUrl:resolvedBaseUrl}=await listen((request,response)=>{
    const url=new URL(request.url!,baseUrl);
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify(
      url.searchParams.get('continue')===null
        ? body('500','token-1')
        : body('501',''),
    ));
  });
  baseUrl=resolvedBaseUrl;
  try {
    const trace=await collect(baseUrl);
    assert.equal(trace.pages.length,2,'Go must preserve rather than reject both pages');
    const result=verify(trace);
    assert.equal(result.state,'indeterminate');
    assert.equal(result.reason,'KUBERNETES_LIST_RESOURCE_VERSION_CHANGED');
  } finally {
    server.close();
  }
});

test('Go records 410; TypeScript interprets continuation expiry',async()=>{
  let baseUrl='';
  const {server,baseUrl:resolvedBaseUrl}=await listen((request,response)=>{
    const url=new URL(request.url!,baseUrl);
    response.setHeader('content-type','application/json');
    if (url.searchParams.get('continue')===null) {
      response.end(JSON.stringify(body('500','expired')));
      return;
    }
    response.statusCode=410;
    response.end(JSON.stringify({kind:'Status',code:410,reason:'Expired'}));
  });
  baseUrl=resolvedBaseUrl;
  try {
    const trace=await collect(baseUrl);
    assert.equal(trace.pages.at(-1)?.response.status,410);
    const result=verify(trace);
    assert.equal(result.state,'indeterminate');
    assert.equal(result.reason,'KUBERNETES_CONTINUATION_EXPIRED');
  } finally {
    server.close();
  }
});

test('tampered Go trace coordinates still fail closed in the existing verifier',async()=>{
  const {server,baseUrl}=await listen((_request,response)=>{
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify(body('500','')));
  });
  try {
    const trace=await collect(baseUrl);
    trace.pages[0].request.namespace='other';
    const result=verify(trace);
    assert.equal(result.state,'indeterminate');
    assert.equal(result.reason,'KUBERNETES_LIST_OBSERVATION_COORDINATE_MISMATCH');
  } finally {
    server.close();
  }
});

test('tampering exact provider bytes without the matching digest fails closed',async()=>{
  const {server,baseUrl}=await listen((_request,response)=>{
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify(body('500','')));
  });
  try {
    const trace=await collect(baseUrl);
    const original=Buffer.from(trace.pages[0].response.body_base64,'base64').toString('utf8');
    const tampered=original.replace('"500"','"999"');
    assert.notEqual(tampered,original);
    trace.pages[0].response.body_base64=Buffer.from(tampered).toString('base64');

    const result=verify(trace);
    assert.equal(result.state,'indeterminate');
    assert.equal(result.reason,'KUBERNETES_GO_TRACE_BODY_DIGEST_MISMATCH');
  } finally {
    server.close();
  }
});
