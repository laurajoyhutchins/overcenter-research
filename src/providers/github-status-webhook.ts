import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export type GithubCommitStatusState='error'|'failure'|'pending'|'success';

export interface GithubWebhookAuthority {
  hook_id:number;
  installation_target_id:number;
  installation_target_type:string;
  installation_id:number;
}

export interface CertifiedGithubStatusWebhookFact {
  provider:'github';
  observer:{kind:'provider-webhook';id:'github-status-webhook/v1'};
  event:'status';
  delivery_id:string;
  payload_sha256:string;
  received_at:string;
  authority:GithubWebhookAuthority;
  repository:{
    id:number;
    full_name:string;
  };
  status:{
    id:number;
    commit_sha:string;
    context:string;
    state:GithubCommitStatusState;
    created_at:string;
    updated_at:string;
  };
}

export interface GithubWebhookDeliveryListPage {
  deliveries:unknown;
  next_cursor:string|null;
  observed_at:string;
}

export type GithubWebhookDeliveryLister=(request:{
  hookId:number;
  cursor:string|null;
})=>Promise<GithubWebhookDeliveryListPage>;

export type GithubStatusMirrorObservation =
  | {
      state:'present';
      actual_state:GithubCommitStatusState;
      evidence:{
        provider:'github';
        source:'certified-webhook-mirror';
        hook_id:number;
        installation_id:number;
        delivery_id:string;
        payload_sha256:string;
        status_id:number;
        status_updated_at:string;
        received_at:string;
        coverage_through:string;
        coverage_valid_until:string;
        canonical_repository_full_name:string;
      };
    }
  | {
      state:'indeterminate';
      reason:
        | 'GITHUB_STATUS_MIRROR_CONTINUITY_UNCERTIFIED'
        | 'GITHUB_STATUS_MIRROR_CONTINUITY_STALE'
        | 'GITHUB_STATUS_MIRROR_MISS'
        | 'GITHUB_STATUS_MIRROR_ORDER_AMBIGUOUS'
        | 'GITHUB_STATUS_MIRROR_FACT_OUTSIDE_RECONCILED_WINDOW';
    };

type GithubWebhookHeaders=Record<string,string|string[]|undefined>;

type MirrorEntry=
  | {state:'present';fact:CertifiedGithubStatusWebhookFact}
  | {
      state:'ambiguous';
      updated_at:string;
      facts:CertifiedGithubStatusWebhookFact[];
    };

export interface GithubWebhookDeliverySummary {
  id:number;
  guid:string;
  delivered_at:string;
  status_code:number;
  event:string;
  installation_id:number|null;
  repository_id:number|null;
}

export interface GithubStatusReconciliationEvidence {
  repository_id:number;
  observed_at:string;
  deliveries:GithubWebhookDeliverySummary[];
}

export interface GithubStatusProjection {
  repository_id:number;
  commit_sha:string;
  context_key:string;
  entry:
    | {state:'present';fact:CertifiedGithubStatusWebhookFact}
    | {
        state:'ambiguous';
        updated_at:string;
        facts:CertifiedGithubStatusWebhookFact[];
      };
}

interface ReconciliationCoverage {
  through:string;
  valid_until:string;
  delivery_ids:Set<string>;
}

const DELIVERY_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID=/^[0-9a-f]{40,64}$/i;
const SIGNATURE=/^sha256=([0-9a-f]{64})$/i;
const MAX_RECONCILIATION_PAGES=1000;

function data(value:unknown):value is Record<string,unknown> {
  return !!value && typeof value==='object' && !Array.isArray(value);
}

function header(headers:GithubWebhookHeaders,name:string):string {
  const target=name.toLowerCase();
  const matches=Object.entries(headers)
    .filter(([key])=>key.toLowerCase()===target)
    .flatMap(([,value])=>Array.isArray(value)?value:value===undefined?[]:[value]);
  if(matches.length!==1 || matches[0].length===0) {
    throw new Error(`GITHUB_WEBHOOK_HEADER_INVALID:${name}`);
  }
  return matches[0];
}

function timestamp(value:unknown,label:string):string {
  if(typeof value!=='string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`GITHUB_WEBHOOK_${label}_INVALID`);
  }
  return value;
}

function positiveInteger(value:unknown,label:string):number {
  if(!Number.isSafeInteger(value) || Number(value)<=0) {
    throw new Error(`GITHUB_WEBHOOK_${label}_INVALID`);
  }
  return Number(value);
}

function nullablePositiveInteger(value:unknown,label:string):number|null {
  if(value===null || value===undefined) return null;
  return positiveInteger(value,label);
}

function nonEmptyString(value:unknown,label:string):string {
  if(typeof value!=='string' || value.length===0) {
    throw new Error(`GITHUB_WEBHOOK_${label}_INVALID`);
  }
  return value;
}

function bytes(value:Uint8Array|string):Buffer {
  return typeof value==='string'?Buffer.from(value,'utf8'):Buffer.from(value);
}

function payloadDigest(body:Buffer):string {
  return createHash('sha256').update(body).digest('hex');
}

function verifySignature(secret:string,body:Buffer,signatureHeader:string):void {
  if(secret.length===0) throw new Error('GITHUB_WEBHOOK_SECRET_REQUIRED');
  const match=SIGNATURE.exec(signatureHeader);
  if(!match) throw new Error('GITHUB_WEBHOOK_SIGNATURE_INVALID');
  const supplied=Buffer.from(match[1],'hex');
  const expected=createHmac('sha256',secret).update(body).digest();
  if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) {
    throw new Error('GITHUB_WEBHOOK_SIGNATURE_INVALID');
  }
}

function validateAuthority(authority:GithubWebhookAuthority):GithubWebhookAuthority {
  return {
    hook_id:positiveInteger(authority.hook_id,'AUTHORITY_HOOK_ID'),
    installation_target_id:positiveInteger(
      authority.installation_target_id,
      'AUTHORITY_INSTALLATION_TARGET_ID',
    ),
    installation_target_type:nonEmptyString(
      authority.installation_target_type,
      'AUTHORITY_INSTALLATION_TARGET_TYPE',
    ),
    installation_id:positiveInteger(
      authority.installation_id,
      'AUTHORITY_INSTALLATION_ID',
    ),
  };
}

function sameAuthority(
  left:GithubWebhookAuthority,
  right:GithubWebhookAuthority,
):boolean {
  return left.hook_id===right.hook_id
    && left.installation_target_id===right.installation_target_id
    && left.installation_target_type===right.installation_target_type
    && left.installation_id===right.installation_id;
}

function statusKey(repositoryId:number,commitSha:string,context:string):string {
  return `${repositoryId}:${commitSha.toLowerCase()}:${context.toLowerCase()}`;
}

function sameStatusIdentity(
  left:CertifiedGithubStatusWebhookFact,
  right:CertifiedGithubStatusWebhookFact,
):boolean {
  return sameAuthority(left.authority,right.authority)
    && left.repository.id===right.repository.id
    && left.status.id===right.status.id
    && left.status.commit_sha===right.status.commit_sha
    && left.status.context.toLowerCase()===right.status.context.toLowerCase()
    && left.status.state===right.status.state
    && left.status.created_at===right.status.created_at
    && left.status.updated_at===right.status.updated_at;
}

function deliverySummary(value:unknown):GithubWebhookDeliverySummary {
  if(!data(value)) throw new Error('GITHUB_WEBHOOK_DELIVERY_SUMMARY_INVALID');
  const guid=nonEmptyString(value.guid,'DELIVERY_GUID');
  if(!DELIVERY_ID.test(guid)) throw new Error('GITHUB_WEBHOOK_DELIVERY_GUID_INVALID');
  const statusCode=positiveInteger(value.status_code,'DELIVERY_STATUS_CODE');
  if(statusCode>599) throw new Error('GITHUB_WEBHOOK_DELIVERY_STATUS_CODE_INVALID');
  return {
    id:positiveInteger(value.id,'DELIVERY_ATTEMPT_ID'),
    guid:guid.toLowerCase(),
    delivered_at:timestamp(value.delivered_at,'DELIVERY_TIME'),
    status_code:statusCode,
    event:nonEmptyString(value.event,'DELIVERY_EVENT'),
    installation_id:nullablePositiveInteger(value.installation_id,'DELIVERY_INSTALLATION_ID'),
    repository_id:nullablePositiveInteger(value.repository_id,'DELIVERY_REPOSITORY_ID'),
  };
}

export function certifyGithubStatusWebhook({
  secret,
  headers,
  body,
  receivedAt,
  expectedAuthority,
}:{
  secret:string;
  headers:GithubWebhookHeaders;
  body:Uint8Array|string;
  receivedAt:string;
  expectedAuthority:GithubWebhookAuthority;
}):CertifiedGithubStatusWebhookFact {
  const raw=bytes(body);
  const signature=header(headers,'x-hub-signature-256');

  // Authenticate the exact bytes before parsing attacker-controlled JSON.
  verifySignature(secret,raw,signature);

  const authority=validateAuthority(expectedAuthority);
  const event=header(headers,'x-github-event');
  if(event!=='status') throw new Error('GITHUB_WEBHOOK_EVENT_INVALID');
  const deliveryId=header(headers,'x-github-delivery');
  if(!DELIVERY_ID.test(deliveryId)) throw new Error('GITHUB_WEBHOOK_DELIVERY_ID_INVALID');

  const hookId=positiveInteger(
    Number(header(headers,'x-github-hook-id')),
    'HOOK_ID',
  );
  const installationTargetId=positiveInteger(
    Number(header(headers,'x-github-hook-installation-target-id')),
    'INSTALLATION_TARGET_ID',
  );
  const installationTargetType=header(
    headers,
    'x-github-hook-installation-target-type',
  );
  if(
    hookId!==authority.hook_id
    || installationTargetId!==authority.installation_target_id
    || installationTargetType!==authority.installation_target_type
  ) {
    throw new Error('GITHUB_WEBHOOK_AUTHORITY_MISMATCH');
  }
  timestamp(receivedAt,'RECEIVED_AT');

  let payload:unknown;
  try {
    payload=JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('GITHUB_WEBHOOK_PAYLOAD_JSON_INVALID');
  }
  if(!data(payload)) throw new Error('GITHUB_WEBHOOK_PAYLOAD_INVALID');

  const repository=payload.repository;
  if(!data(repository)) throw new Error('GITHUB_WEBHOOK_REPOSITORY_INVALID');
  const repositoryId=positiveInteger(repository.id,'REPOSITORY_ID');
  const repositoryFullName=nonEmptyString(repository.full_name,'REPOSITORY_FULL_NAME');

  const installation=payload.installation;
  if(!data(installation)) throw new Error('GITHUB_WEBHOOK_INSTALLATION_INVALID');
  const installationId=positiveInteger(installation.id,'INSTALLATION_ID');
  if(installationId!==authority.installation_id) {
    throw new Error('GITHUB_WEBHOOK_INSTALLATION_ID_MISMATCH');
  }

  const statusId=positiveInteger(payload.id,'STATUS_ID');
  const commitSha=nonEmptyString(payload.sha,'SHA').toLowerCase();
  if(!OBJECT_ID.test(commitSha)) throw new Error('GITHUB_WEBHOOK_SHA_INVALID');
  const context=nonEmptyString(payload.context,'CONTEXT');
  const state=payload.state;
  if(!['error','failure','pending','success'].includes(String(state))) {
    throw new Error('GITHUB_WEBHOOK_STATE_INVALID');
  }

  return {
    provider:'github',
    observer:{kind:'provider-webhook',id:'github-status-webhook/v1'},
    event:'status',
    delivery_id:deliveryId.toLowerCase(),
    payload_sha256:payloadDigest(raw),
    received_at:receivedAt,
    authority,
    repository:{
      id:repositoryId,
      full_name:repositoryFullName,
    },
    status:{
      id:statusId,
      commit_sha:commitSha,
      context,
      state:state as GithubCommitStatusState,
      created_at:timestamp(payload.created_at,'CREATED_AT'),
      updated_at:timestamp(payload.updated_at,'UPDATED_AT'),
    },
  };
}

export class GithubStatusMirror {
  private readonly authority:GithubWebhookAuthority;
  private readonly maxCoverageAgeMs:number;
  private readonly deliveries=new Map<string,CertifiedGithubStatusWebhookFact>();
  private readonly current=new Map<string,MirrorEntry>();
  private readonly coverageByRepository=new Map<number,ReconciliationCoverage>();

  constructor(
    authority:GithubWebhookAuthority,
    {maxCoverageAgeMs}:{maxCoverageAgeMs:number},
  ) {
    this.authority=validateAuthority(authority);
    if(!Number.isSafeInteger(maxCoverageAgeMs) || maxCoverageAgeMs<0) {
      throw new Error('GITHUB_STATUS_MIRROR_COVERAGE_AGE_INVALID');
    }
    this.maxCoverageAgeMs=maxCoverageAgeMs;
  }

  ingest(fact:CertifiedGithubStatusWebhookFact):'applied'|'ignored'|'duplicate'|'ambiguous' {
    if(!sameAuthority(fact.authority,this.authority)) {
      throw new Error('GITHUB_STATUS_MIRROR_AUTHORITY_MISMATCH');
    }

    const previous=this.deliveries.get(fact.delivery_id);
    if(previous!==undefined) {
      if(previous.payload_sha256!==fact.payload_sha256) {
        throw new Error('GITHUB_WEBHOOK_DELIVERY_REUSE_MISMATCH');
      }
      return 'duplicate';
    }
    this.deliveries.set(fact.delivery_id,fact);

    const key=statusKey(
      fact.repository.id,
      fact.status.commit_sha,
      fact.status.context,
    );
    const current=this.current.get(key);
    if(!current) {
      this.current.set(key,{state:'present',fact});
      return 'applied';
    }

    const previousTime=Date.parse(
      current.state==='present'?current.fact.status.updated_at:current.updated_at,
    );
    const nextTime=Date.parse(fact.status.updated_at);
    if(nextTime<previousTime) return 'ignored';
    if(nextTime>previousTime) {
      this.current.set(key,{state:'present',fact});
      return 'applied';
    }

    if(current.state==='present') {
      if(current.fact.status.id===fact.status.id) {
        if(!sameStatusIdentity(current.fact,fact)) {
          throw new Error('GITHUB_STATUS_IDENTITY_REUSE_MISMATCH');
        }
        return 'ignored';
      }
      this.current.set(key,{
        state:'ambiguous',
        updated_at:fact.status.updated_at,
        facts:[current.fact,fact],
      });
      return 'ambiguous';
    }

    const same=current.facts.find(candidate=>candidate.status.id===fact.status.id);
    if(same) {
      if(!sameStatusIdentity(same,fact)) {
        throw new Error('GITHUB_STATUS_IDENTITY_REUSE_MISMATCH');
      }
      return 'ignored';
    }
    current.facts.push(fact);
    return 'ambiguous';
  }

  async reconcileRepository({
    repositoryId,
    list,
  }:{
    repositoryId:number;
    list:GithubWebhookDeliveryLister;
  }):Promise<GithubStatusReconciliationEvidence> {
    positiveInteger(repositoryId,'RECONCILIATION_REPOSITORY_ID');
    const attempts:GithubWebhookDeliverySummary[]=[];
    const seenCursors=new Set<string>();
    let cursor:string|null=null;
    let through:string|null=null;

    for(let page=0;page<MAX_RECONCILIATION_PAGES;page+=1) {
      const response=await list({hookId:this.authority.hook_id,cursor});
      if(!Array.isArray(response.deliveries)) {
        throw new Error('GITHUB_WEBHOOK_DELIVERY_LIST_INVALID');
      }
      const pageObservedAt=timestamp(
        response.observed_at,
        'DELIVERY_LIST_OBSERVED_AT',
      );
      if(through===null) {
        through=pageObservedAt;
      } else if(Date.parse(pageObservedAt)<Date.parse(through)) {
        throw new Error('GITHUB_WEBHOOK_DELIVERY_LIST_TIME_REGRESSION');
      }
      attempts.push(...response.deliveries.map(deliverySummary));

      const next=response.next_cursor;
      if(next!==null && (typeof next!=='string' || next.length===0)) {
        throw new Error('GITHUB_WEBHOOK_DELIVERY_CURSOR_INVALID');
      }
      if(next===null) {
        cursor=null;
        break;
      }
      if(seenCursors.has(next)) throw new Error('GITHUB_WEBHOOK_DELIVERY_CURSOR_LOOP');
      seenCursors.add(next);
      cursor=next;

      if(page===MAX_RECONCILIATION_PAGES-1) {
        throw new Error('GITHUB_WEBHOOK_DELIVERY_SCAN_LIMIT_REACHED');
      }
    }
    if(cursor!==null) throw new Error('GITHUB_WEBHOOK_DELIVERY_SCAN_INCOMPLETE');
    if(through===null) throw new Error('GITHUB_WEBHOOK_DELIVERY_LIST_UNOBSERVED');

    const evidence:GithubStatusReconciliationEvidence={
      repository_id:repositoryId,
      observed_at:through,
      deliveries:attempts,
    };
    this.reconcileRepositoryEvidence(evidence);
    return structuredClone(evidence);
  }

  reconcileRepositoryEvidence({
    repository_id:repositoryId,
    observed_at:observedAt,
    deliveries,
  }:GithubStatusReconciliationEvidence):void {
    positiveInteger(repositoryId,'RECONCILIATION_REPOSITORY_ID');
    const through=timestamp(observedAt,'RECONCILIATION_TIME');
    const attempts=deliveries.map(delivery=>deliverySummary(delivery));
    const relevant=attempts.filter(attempt=>
      attempt.event==='status'
      && attempt.repository_id===repositoryId
      && attempt.installation_id===this.authority.installation_id
      && Date.parse(attempt.delivered_at)<=Date.parse(through)
    );
    const byDelivery=new Map<string,GithubWebhookDeliverySummary[]>();
    for(const attempt of relevant) {
      const group=byDelivery.get(attempt.guid)??[];
      group.push(attempt);
      byDelivery.set(attempt.guid,group);
    }

    const covered=new Set<string>();
    for(const [guid,group] of byDelivery) {
      const succeeded=group.some(attempt=>
        attempt.status_code>=200 && attempt.status_code<=399
      );
      const mirrored=this.deliveries.get(guid);
      if(!succeeded || !mirrored || mirrored.repository.id!==repositoryId) {
        throw new Error(`GITHUB_STATUS_MIRROR_DELIVERY_GAP:${guid}`);
      }
      covered.add(guid);
    }

    const validUntil=new Date(
      Date.parse(through)+this.maxCoverageAgeMs,
    ).toISOString();
    this.coverageByRepository.set(repositoryId,{
      through,
      valid_until:validUntil,
      delivery_ids:covered,
    });
  }

  projectionAt({
    repositoryId,
    commitSha,
    context,
  }:{
    repositoryId:number;
    commitSha:string;
    context:string;
  }):GithubStatusProjection|null {
    const entry=this.current.get(statusKey(repositoryId,commitSha,context));
    if(!entry) return null;
    return {
      repository_id:repositoryId,
      commit_sha:commitSha.toLowerCase(),
      context_key:context.toLowerCase(),
      entry:structuredClone(entry),
    };
  }

  projections():GithubStatusProjection[] {
    const projections:GithubStatusProjection[]=[];
    for(const [key,entry] of this.current) {
      const first=key.indexOf(':');
      const second=key.indexOf(':',first+1);
      projections.push({
        repository_id:Number(key.slice(0,first)),
        commit_sha:key.slice(first+1,second),
        context_key:key.slice(second+1),
        entry:structuredClone(entry),
      });
    }
    return projections.sort((left,right)=>
      [left.repository_id,left.commit_sha,left.context_key]
        .join(':')
        .localeCompare([right.repository_id,right.commit_sha,right.context_key].join(':')),
    );
  }

  observe({
    repositoryId,
    commitSha,
    context,
    observedAt,
  }:{
    repositoryId:number;
    commitSha:string;
    context:string;
    observedAt:string;
  }):GithubStatusMirrorObservation {
    const now=Date.parse(timestamp(observedAt,'OBSERVED_AT'));
    const coverage=this.coverageByRepository.get(repositoryId);
    if(!coverage) {
      return {
        state:'indeterminate',
        reason:'GITHUB_STATUS_MIRROR_CONTINUITY_UNCERTIFIED',
      };
    }
    if(now>Date.parse(coverage.valid_until)) {
      return {
        state:'indeterminate',
        reason:'GITHUB_STATUS_MIRROR_CONTINUITY_STALE',
      };
    }

    const entry=this.current.get(statusKey(repositoryId,commitSha,context));
    if(!entry) {
      return {
        state:'indeterminate',
        reason:'GITHUB_STATUS_MIRROR_MISS',
      };
    }
    if(entry.state==='ambiguous') {
      return {
        state:'indeterminate',
        reason:'GITHUB_STATUS_MIRROR_ORDER_AMBIGUOUS',
      };
    }
    if(!coverage.delivery_ids.has(entry.fact.delivery_id)) {
      return {
        state:'indeterminate',
        reason:'GITHUB_STATUS_MIRROR_FACT_OUTSIDE_RECONCILED_WINDOW',
      };
    }

    return {
      state:'present',
      actual_state:entry.fact.status.state,
      evidence:{
        provider:'github',
        source:'certified-webhook-mirror',
        hook_id:this.authority.hook_id,
        installation_id:this.authority.installation_id,
        delivery_id:entry.fact.delivery_id,
        payload_sha256:entry.fact.payload_sha256,
        status_id:entry.fact.status.id,
        status_updated_at:entry.fact.status.updated_at,
        received_at:entry.fact.received_at,
        coverage_through:coverage.through,
        coverage_valid_until:coverage.valid_until,
        canonical_repository_full_name:entry.fact.repository.full_name,
      },
    };
  }
}
