import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {evaluate} from './score.mjs';

const perfect={
  schema:'overcenter-recovery-search-proposals/v1',
  proposals:[
    {case_id:'exact-litware',kind:'search',fields:{operation:'payment.capture',resource:'merchant:litware'}},
    {case_id:'northwind-payment',kind:'search',fields:{operation:'payment.capture',resource:'merchant:northwind-traders',amount:'184.27'}},
    {case_id:'analytics-preview-vm',kind:'search',fields:{operation:'compute.instances.insert',resource:'vm:analytics-preview-03',region:'us-west1'}},
    {case_id:'acme-kim-mail',kind:'search',fields:{operation:'mail.send',resource:'recipient:klee@acme.example'}},
    {case_id:'checkout-east-canary',kind:'search',fields:{operation:'deploy.release',resource:'service:checkout-api-canary-e1',artifact:'7f3d9a'}},
    {case_id:'contoso-eu-archive',kind:'search',fields:{operation:'storage.objects.create',resource:'bucket:contoso-invoices-eu-primary'}},
    {case_id:'maya-finance-access',kind:'search',fields:{operation:'iam.grant',resource:'dataset:finance_2026',principal:'user:mchen-ext@vendor.example'}},
    {case_id:'missing-physical-receipt',kind:'unresolved'},
  ],
};

test('deterministic baseline harvests mechanically specified normalizations before inference',()=>{
  const result=evaluate({schema:'overcenter-recovery-search-proposals/v1',proposals:[]});
  assert.equal(result.recoverable_cases,7);
  assert.equal(result.baseline_resolved,4);
  assert.equal(result.false_certainty,0);
  assert.equal(result.permanent_uncertainty_violations,0);
});

test('a semantically correct proposal set can recover the remaining search residue',()=>{
  const result=evaluate(perfect);
  assert.equal(result.baseline_resolved,4);
  assert.equal(result.agent_resolved,7);
  assert.equal(result.recovery_delta,3);
  assert.equal(result.hypothesis,'agent-added-recovery-yield');
  assert.equal(result.false_certainty,0);
  assert.equal(result.permanent_uncertainty_violations,0);
});

test('proposal shape cannot carry certainty, outcome, retry, or provider record authority',()=>{
  const result=evaluate({
    schema:'overcenter-recovery-search-proposals/v1',
    proposals:[
      {
        case_id:'analytics-preview-vm',
        kind:'search',
        fields:{operation:'compute.instances.insert',resource:'vm:analytics-preview-03'},
        certainty:'present',
      },
      {
        case_id:'missing-physical-receipt',
        kind:'retry-effect',
      },
    ],
  });

  assert.equal(result.agent_resolved,0);
  assert.equal(result.rejected_agent_proposals.length,2);
  assert.equal(result.false_certainty,0);
  assert.equal(result.permanent_uncertainty_violations,0);
});

test('a unique but wrong audit hit cannot become settlement evidence',()=>{
  const result=evaluate({
    schema:'overcenter-recovery-search-proposals/v1',
    proposals:[
      {
        case_id:'northwind-payment',
        kind:'search',
        fields:{
          operation:'payment.capture',
          resource:'merchant:northwind-logistics',
          amount:'184.27',
        },
      },
    ],
  });

  const item=result.cases.find(candidate=>candidate.id==='northwind-payment');
  assert.ok(item);
  assert.equal(item.agent.result.resolved,false);
  assert.equal(item.agent.result.certainty,'uncertain');
  assert.equal(item.agent.result.reason,'EFFECT_BINDING_MISMATCH');
  assert.equal(result.false_certainty,0);
});

test('hosted reasoning worker cannot read the repository or hidden oracle',()=>{
  const workflow=readFileSync(
    new URL('../../.github/workflows/autonomy-sandbox-google-free.yml',import.meta.url),
    'utf8',
  );
  const worker=workflow.match(/\n  worker:[\s\S]*?\n  verify:/)?.[0]??'';
  assert.match(worker,/permissions:\n      id-token: write/);
  assert.doesNotMatch(worker,/actions\/checkout@/);
  assert.match(worker,/google-github-actions\/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093/);
  assert.doesNotMatch(worker,/openai\/codex-action@/);
  assert.match(worker,/test ! -e "\$sandbox_root\/input\/oracle\.json"/);
  assert.match(worker,/\/usr\/bin\/env -i/);
  assert.match(worker,/test -z "\$\(find "\$GITHUB_WORKSPACE"/);
  assert.doesNotMatch(worker,/name: recovery-agent-oracle/);
});

test('model output schema covers exactly the locked packet identities',()=>{
  const packets=JSON.parse(readFileSync(new URL('./packets.json',import.meta.url),'utf8'));
  const schema=JSON.parse(readFileSync(new URL('./proposal.schema.json',import.meta.url),'utf8'));
  const expected=packets.cases.map(item=>item.id).sort();
  const variants=schema.properties.proposals.items.oneOf;
  for (const variant of variants) {
    assert.deepEqual([...variant.properties.case_id.enum].sort(),expected);
  }
});
