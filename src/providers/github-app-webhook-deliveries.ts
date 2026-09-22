import {GITHUB_API_VERSION} from './github-contract.ts';
import type {
  GithubWebhookDeliveryListPage,
  GithubWebhookDeliveryLister,
} from './github-status-webhook.ts';

export interface GithubAppWebhookHttpResponse {
  status:number;
  body:string;
  headers:Record<string,string>;
}

export type GithubAppWebhookHttpGet=(
  appJwt:string,
  path:string,
)=>Promise<GithubAppWebhookHttpResponse>;

async function githubAppWebhookHttpGet(
  appJwt:string,
  path:string,
):Promise<GithubAppWebhookHttpResponse> {
  if(!appJwt) throw new Error('GITHUB_APP_JWT_REQUIRED');
  const response=await fetch(`https://api.github.com${path}`,{
    method:'GET',
    headers:{
      Authorization:`Bearer ${appJwt}`,
      Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':GITHUB_API_VERSION,
    },
  });
  return {
    status:response.status,
    body:await response.text(),
    headers:Object.fromEntries(response.headers.entries()),
  };
}

function nextCursor(linkHeader:string|undefined):string|null {
  if(!linkHeader) return null;
  let next:string|null=null;
  for(const part of linkHeader.split(',')) {
    const match=/^\s*<([^>]+)>(.*)$/.exec(part);
    if(!match) throw new Error('GITHUB_APP_WEBHOOK_PAGINATION_LINK_INVALID');
    const relations=[...match[2].matchAll(/;\s*rel="([^"]+)"/g)]
      .flatMap(value=>value[1].split(/\s+/));
    if(!relations.includes('next')) continue;
    if(next!==null) throw new Error('GITHUB_APP_WEBHOOK_PAGINATION_NEXT_DUPLICATE');
    const url=new URL(match[1]);
    if(url.protocol!=='https:' || url.hostname!=='api.github.com') {
      throw new Error('GITHUB_APP_WEBHOOK_PAGINATION_URL_INVALID');
    }
    if(url.pathname!=='/app/hook/deliveries') {
      throw new Error('GITHUB_APP_WEBHOOK_PAGINATION_PATH_INVALID');
    }
    const cursor=url.searchParams.get('cursor');
    if(!cursor) throw new Error('GITHUB_APP_WEBHOOK_PAGINATION_CURSOR_MISSING');
    next=cursor;
  }
  return next;
}

export function createGithubAppWebhookDeliveryLister(
  appJwt:string,
  {
    expectedHookId,
    get=githubAppWebhookHttpGet,
  }:{
    expectedHookId:number;
    get?:GithubAppWebhookHttpGet;
  },
):GithubWebhookDeliveryLister {
  if(!appJwt) throw new Error('GITHUB_APP_JWT_REQUIRED');
  if(!Number.isSafeInteger(expectedHookId) || expectedHookId<=0) {
    throw new Error('GITHUB_APP_WEBHOOK_HOOK_ID_INVALID');
  }

  return async({hookId,cursor}):Promise<GithubWebhookDeliveryListPage>=>{
    if(hookId!==expectedHookId) {
      throw new Error('GITHUB_APP_WEBHOOK_HOOK_ID_MISMATCH');
    }
    const query=new URLSearchParams({per_page:'100'});
    if(cursor!==null) {
      if(typeof cursor!=='string' || cursor.length===0) {
        throw new Error('GITHUB_APP_WEBHOOK_CURSOR_INVALID');
      }
      query.set('cursor',cursor);
    }

    const response=await get(
      appJwt,
      `/app/hook/deliveries?${query.toString()}`,
    );
    if(response.status!==200) {
      throw new Error(
        `GITHUB_APP_WEBHOOK_DELIVERY_LIST_FAILED:${response.status}:${response.body}`,
      );
    }

    let deliveries:unknown;
    try {
      deliveries=JSON.parse(response.body);
    } catch {
      throw new Error('GITHUB_APP_WEBHOOK_DELIVERY_LIST_JSON_INVALID');
    }
    if(!Array.isArray(deliveries)) {
      throw new Error('GITHUB_APP_WEBHOOK_DELIVERY_LIST_SHAPE_INVALID');
    }

    const header=(name:string)=>Object.entries(response.headers)
      .find(([candidate])=>candidate.toLowerCase()===name.toLowerCase())?.[1];
    const observedAt=header('date');
    if(!observedAt || !Number.isFinite(Date.parse(observedAt))) {
      throw new Error('GITHUB_APP_WEBHOOK_DATE_HEADER_INVALID');
    }
    return {
      deliveries,
      next_cursor:nextCursor(header('link')),
      observed_at:new Date(observedAt).toISOString(),
    };
  };
}
