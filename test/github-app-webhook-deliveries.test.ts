import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGithubAppWebhookDeliveryLister,
  type GithubAppWebhookHttpGet,
} from '../src/providers/github-app-webhook-deliveries.ts';

const JWT='app-jwt';
const HOOK=9001;

test('GitHub App delivery lister uses app-hook endpoint and cursor pagination',async()=>{
  const calls:string[]=[];
  const get:GithubAppWebhookHttpGet=async(token,path)=>{
    calls.push(`${token} ${path}`);
    if(calls.length===1) {
      return {
        status:200,
        body:JSON.stringify([{id:1}]),
        headers:{
          date:'Mon, 21 Sep 2026 06:01:00 GMT',
          link:'<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next-1>; rel="next"',
        },
      };
    }
    return {
      status:200,
      body:JSON.stringify([{id:2}]),
      headers:{date:'Mon, 21 Sep 2026 06:01:01 GMT'},
    };
  };

  const list=createGithubAppWebhookDeliveryLister(JWT,{
    expectedHookId:HOOK,
    get,
  });
  const first=await list({hookId:HOOK,cursor:null});
  assert.deepEqual(first.deliveries,[{id:1}]);
  assert.equal(first.next_cursor,'next-1');
  assert.equal(first.observed_at,'2026-09-21T06:01:00.000Z');

  const second=await list({hookId:HOOK,cursor:first.next_cursor});
  assert.deepEqual(second.deliveries,[{id:2}]);
  assert.equal(second.next_cursor,null);
  assert.equal(second.observed_at,'2026-09-21T06:01:01.000Z');

  assert.deepEqual(calls,[
    `${JWT} /app/hook/deliveries?per_page=100`,
    `${JWT} /app/hook/deliveries?per_page=100&cursor=next-1`,
  ]);
});

test('GitHub App delivery lister rejects authority and pagination drift',async()=>{
  const ok:GithubAppWebhookHttpGet=async()=>({
    status:200,
    body:'[]',
    headers:{},
  });
  const list=createGithubAppWebhookDeliveryLister(JWT,{
    expectedHookId:HOOK,
    get:ok,
  });
  await assert.rejects(
    list({hookId:HOOK+1,cursor:null}),
    /GITHUB_APP_WEBHOOK_HOOK_ID_MISMATCH/,
  );

  const hostile=createGithubAppWebhookDeliveryLister(JWT,{
    expectedHookId:HOOK,
    get:async()=>({
      status:200,
      body:'[]',
      headers:{
        date:'Mon, 21 Sep 2026 06:01:00 GMT',
        link:'<https://evil.example/app/hook/deliveries?cursor=x>; rel="next"',
      },
    }),
  });
  await assert.rejects(
    hostile({hookId:HOOK,cursor:null}),
    /GITHUB_APP_WEBHOOK_PAGINATION_URL_INVALID/,
  );
});

test('GitHub App delivery lister requires provider response time',async()=>{
  const missingDate=createGithubAppWebhookDeliveryLister(JWT,{
    expectedHookId:HOOK,
    get:async()=>({status:200,body:'[]',headers:{}}),
  });
  await assert.rejects(
    missingDate({hookId:HOOK,cursor:null}),
    /GITHUB_APP_WEBHOOK_DATE_HEADER_INVALID/,
  );
});

test('GitHub App delivery lister fails closed on transport and response-shape errors',async()=>{
  const failed=createGithubAppWebhookDeliveryLister(JWT,{
    expectedHookId:HOOK,
    get:async()=>({status:401,body:'bad jwt',headers:{}}),
  });
  await assert.rejects(
    failed({hookId:HOOK,cursor:null}),
    /GITHUB_APP_WEBHOOK_DELIVERY_LIST_FAILED:401:bad jwt/,
  );

  const malformed=createGithubAppWebhookDeliveryLister(JWT,{
    expectedHookId:HOOK,
    get:async()=>({status:200,body:'{}',headers:{}}),
  });
  await assert.rejects(
    malformed({hookId:HOOK,cursor:null}),
    /GITHUB_APP_WEBHOOK_DELIVERY_LIST_SHAPE_INVALID/,
  );
});
