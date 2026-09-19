import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOvercenterKernel } from '../../src/git-kernel.ts';
import type { Work } from '../../src/model.ts';
import {
  carryKubernetesAbsenceThroughWatch,
  KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
  observeCertifiedKubernetesConfigMap,
  type KubernetesConfigMapListRead,
  type KubernetesListConfigMaps,
} from '../../src/providers/kubernetes-configmap.ts';
import type { GithubJsonGet } from '../../src/providers/github-certified-status.ts';

export type ScenarioProvider='github-status'|'kubernetes-configmap';
export type ScenarioObservation=
  | 'missing'
  | 'present'
  | 'wrong-coordinate'
  | 'continuation-expires';

const GITHUB_COMMIT='a'.repeat(40);
const KUBERNETES_AUTHORITY='kind:ruby-scenario-cluster';
const KUBERNETES_SCHEMA_SHA='b'.repeat(64);

const kubernetesListOperation={
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

function githubRepository(id=42) {
  return {
    id,
    node_id:`R_${id}`,
    full_name:'acme/widget',
    name:'widget',
    owner:{login:'acme'},
  };
}

function githubStatus(context='overcenter/ruby-scenario') {
  return {
    id:1,
    node_id:'STATUS_1',
    state:'success',
    context,
    target_url:null,
    created_at:'2026-09-18T16:00:00Z',
    updated_at:'2026-09-18T16:01:00Z',
  };
}

function githubGetFor(event:ScenarioObservation):GithubJsonGet {
  return (_token,path)=>{
    if (path==='/repos/acme/widget') {
      return event==='wrong-coordinate'
        ? githubRepository(43)
        : githubRepository();
    }

    if (!path.includes(`/commits/${GITHUB_COMMIT}/statuses`)) {
      throw new Error(`UNEXPECTED_GITHUB_PATH:${path}`);
    }

    if (event==='present') return [githubStatus()];
    if (event==='missing') return [];
    return [];
  };
}

function kubernetesPage(
  request:{
    namespace:string;
    continue_token:string|null;
    limit:number;
  },
  {
    status=200,
    resourceVersion='500',
    next='',
    items=[],
    requestNamespace=request.namespace,
    requestContinue=request.continue_token,
  }:{
    status?:number;
    resourceVersion?:string;
    next?:string;
    items?:Array<{
      name:string;
      namespace:string;
      uid:string;
      resourceVersion:string;
    }>;
    requestNamespace?:string;
    requestContinue?:string|null;
  }={},
):KubernetesConfigMapListRead {
  return {
    operation:kubernetesListOperation,
    observation:{
      contract:{
        provider:'kubernetes',
        api_version:'v1',
        operation_id:KUBERNETES_CONFIGMAP_LIST_OPERATION_ID,
        schema_sha256:KUBERNETES_SCHEMA_SHA,
      },
      authority_id:KUBERNETES_AUTHORITY,
      observer:{kind:'ruby-scenario',id:'provider-general'},
      observed_at:'2026-09-18T19:30:00.000Z',
      request:{
        namespace:requestNamespace,
        continue_token:requestContinue,
        limit:request.limit,
      },
      response:{},
      outcome:status===200
        ? {
            status,
            visibility:'observed',
            value:{
              apiVersion:'v1',
              kind:'ConfigMapList',
              metadata:{resourceVersion,continue:next},
              items:items.map(item=>({metadata:item})),
            },
          }
        : {
            status,
            visibility:'indeterminate',
          },
    },
  };
}

function kubernetesListFor(event:ScenarioObservation):KubernetesListConfigMaps {
  if (event==='continuation-expires') {
    return request=>request.continue_token===null
      ? kubernetesPage(request,{next:'expired-token'})
      : kubernetesPage(request,{status:410});
  }

  if (event==='wrong-coordinate') {
    return request=>kubernetesPage(request,{requestNamespace:'other'});
  }

  if (event==='present') {
    return request=>kubernetesPage(request,{
      items:[{
        name:'target',
        namespace:'proof',
        uid:'uid-target',
        resourceVersion:'499',
      }],
    });
  }

  return request=>request.continue_token===null
    ? kubernetesPage(request,{next:'token-1'})
    : kubernetesPage(request,{next:''});
}

export function runProviderObservationCase(
  provider:ScenarioProvider,
  event:ScenarioObservation,
):{receipt:ReturnType<GitOvercenterKernel['resolve']>;work:Work} {
  const root=mkdtempSync(join(tmpdir(),`overcenter-ruby-${provider}-`));
  const authority=join(root,'authority.git');

  try {
    execFileSync('git',['init','--bare',authority],{stdio:'ignore'});

    const kernel=provider==='github-status'
      ? new GitOvercenterKernel(authority,{
          githubToken:'scenario-token',
          observationContext:{
            githubGet:githubGetFor(event),
            clock:()=> '2026-09-18T20:00:00.000Z',
          },
        })
      : new GitOvercenterKernel(authority,{
          observationContext:{
            kubernetesListConfigMaps:kubernetesListFor(event),
          },
        });

    kernel.initialize();

    if (provider==='github-status') {
      kernel.define({
        id:'provider-target',
        postcondition:{
          verifier:'github-commit-status/v2',
          provider:'github',
          repository_id:42,
          repository_full_name:'acme/widget',
          commit_sha:GITHUB_COMMIT,
          context:'overcenter/ruby-scenario',
          expected_state:'success',
        },
      });
    } else {
      kernel.define({
        id:'provider-target',
        postcondition:{
          verifier:'kubernetes-configmap-exists/v1',
          provider:'kubernetes',
          authority_id:KUBERNETES_AUTHORITY,
          api_group:'',
          resource:'configmaps',
          namespace:'proof',
          name:'target',
        },
      });
    }

    const ready=kernel.deriveReadyWork();
    if (!ready) throw new Error('PROVIDER_SCENARIO_NOT_READY');
    const permit=kernel.claim(ready.id,ready.revision);
    const receipt=kernel.resolve(permit);
    const work=kernel.inspect()[0];
    if (!work) throw new Error('PROVIDER_SCENARIO_WORK_MISSING');
    return {receipt,work};
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
}


export function runProviderContinuityCase(
  provider:ScenarioProvider,
  continuity:'maintained'|'broken',
):{evidence_preserved:boolean} {
  if (provider!=='kubernetes-configmap') {
    throw new Error(`CONTINUITY_SCENARIO_UNSUPPORTED:${provider}`);
  }

  const postcondition={
    verifier:'kubernetes-configmap-exists/v1' as const,
    provider:'kubernetes' as const,
    authority_id:KUBERNETES_AUTHORITY,
    api_group:'' as const,
    resource:'configmaps' as const,
    namespace:'proof',
    name:'target',
  };
  const absent=observeCertifiedKubernetesConfigMap(postcondition,{
    list:kubernetesListFor('missing'),
  });
  if (absent.state!=='absent' || !absent.absence_evidence) {
    throw new Error('BASE_ABSENCE_CERTIFICATE_MISSING');
  }

  const carried=carryKubernetesAbsenceThroughWatch(
    postcondition,
    absent.absence_evidence,
    {
      authority_id:KUBERNETES_AUTHORITY,
      namespace:'proof',
      start_resource_version:'500',
      last_resource_version:'510',
      continuity:continuity==='maintained'
        ? 'maintained'
        : 'broken-relist-required',
      termination:continuity==='maintained' ? 'timeout' : 'gone',
      target_events:[],
    },
  );

  return {evidence_preserved:carried!==null};
}
