import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CLAIM_SCHEMA,
  LEGACY_OBLIGATION_SCHEMA,
  LEGACY_RECEIPT_SCHEMA,
  OBLIGATION_SCHEMA,
  RECEIPT_SCHEMA,
} from '../src/facts.ts';
import type { FactCommit, ObligationFact, ReceiptFact } from '../src/facts.ts';
import { obligationKey } from '../src/semantic-identity.ts';
import { projectReceipt, replayProjection } from '../src/projection.ts';
import type { Obligation } from '../src/model.ts';
import { localFileEnoentEvidence } from '../src/evidence.ts';

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');

const obligation:Obligation={
  id:'a',
  dependencies:[],
  packet:{kind:'pure-projection-proof'},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:'/provider/a',
    content:'A',
  },
};

const defined:ObligationFact={
  schema:OBLIGATION_SCHEMA,
  kind:'defined',
  obligation,
};

function claimCommit(parent:string):FactCommit {
  const base=replayProjection([
    {commit:parent,parent:null,obligation:defined},
  ]);
  const key=obligationKey(
    base.state,
    obligation,
    base.project.lifecycles,
    base.history.receiptsByRun,
  );
  assert.ok(key);
  return {
    commit:'claim-1',
    parent,
    claim:{
      schema:CLAIM_SCHEMA,
      run_id:'run-1',
      obligation_id:'a',
      claimed_revision:parent,
      obligation_key:key,
      execution_capability_sha256:sha256('permit-1'),
    },
  };
}

test('pure replay derives UNREALIZED -> EXECUTING -> DONE without Git',()=>{
  const defineRecord:FactCommit={
    commit:'define-1',
    parent:null,
    obligation:defined,
  };
  const ready=replayProjection([defineRecord]);
  assert.equal(ready.project.lifecycles.get('a')?.status,'UNREALIZED');

  const claimRecord=claimCommit('define-1');
  const executing=replayProjection([defineRecord,claimRecord]);
  assert.equal(executing.project.lifecycles.get('a')?.status,'EXECUTING');

  const receipt:ReceiptFact={
    schema:RECEIPT_SCHEMA,
    run_id:'run-1',
    obligation_id:'a',
    claimed_revision:'define-1',
    claim_commit:'claim-1',
    execution_generation:1,
    execution_authority_commit:'claim-1',
    kind:'observation',
    observed:{
      verifier:'file-content-equals/v1',
      path:'/provider/a',
      expected_sha256:sha256('A'),
      actual_sha256:sha256('A'),
      mutation_certainty:'present',
    },
    settled_at:'2026-09-18T00:00:00.000Z',
  };
  const done=replayProjection([
    defineRecord,
    claimRecord,
    {commit:'receipt-1',parent:'claim-1',receipt},
  ]);

  assert.equal(done.project.lifecycles.get('a')?.status,'DONE');
  assert.equal(done.history.receipts.at(-1)?.verified,true);
  assert.equal(done.history.receipts.at(-1)?.settlement_commit,'receipt-1');
});

test('pure replay rejects a claim whose parent is not its claimed revision',()=>{
  const defineRecord:FactCommit={
    commit:'define-1',
    parent:null,
    obligation:defined,
  };
  const claimRecord=claimCommit('define-1');
  claimRecord.parent='different-head';

  assert.throws(
    ()=>replayProjection([defineRecord,claimRecord]),
    /CLAIM_REVISION_MISMATCH/,
  );
});

function absentReceipt(
  work:Obligation,
  {
    schema=RECEIPT_SCHEMA,
    includeCertificate=false,
    certificatePath,
  }:{
    schema?:ReceiptFact['schema'];
    includeCertificate?:boolean;
    certificatePath?:string;
  }={},
):ReceiptFact {
  const observed=work.postcondition.verifier==='github-commit-status/v1'
    ? {
        verifier:work.postcondition.verifier,
        provider:'github' as const,
        repository_id:work.postcondition.repository_id,
        commit_sha:work.postcondition.commit_sha,
        context:work.postcondition.context,
        mutation_certainty:'absent' as const,
      }
    : {
        verifier:work.postcondition.verifier,
        path:work.postcondition.path,
        mutation_certainty:'absent' as const,
        ...(includeCertificate && work.postcondition.verifier==='file-content-equals/v1'
          ? {
              absence_evidence:localFileEnoentEvidence(
                certificatePath??work.postcondition.path,
              ),
            }
          : {}),
      };
  return {
    schema,
    run_id:'run-absence',
    obligation_id:'absence',
    claimed_revision:'revision-absence',
    claim_commit:'claim-absence',
    execution_generation:1,
    execution_authority_commit:'authority-absence',
    kind:'observation',
    observed,
    settled_at:'2026-09-18T00:00:00.000Z',
  };
}

test('receipt v5 requires a matching absence certificate before replay',()=>{
  const local:Obligation={
    id:'absence',
    dependencies:[],
    packet:{},
    postcondition:{verifier:'file-content-equals/v1',path:'/provider/absence',content:'A'},
  };
  assert.equal(
    projectReceipt(
      absentReceipt(local,{includeCertificate:true}),
      local,
    ).disposition,
    'READY',
  );
  assert.equal(
    projectReceipt(absentReceipt(local),local).disposition,
    'RECOVERY_REQUIRED',
  );
  assert.equal(
    projectReceipt(
      absentReceipt(local,{
        includeCertificate:true,
        certificatePath:'/provider/wrong-certificate-subject',
      }),
      local,
    ).disposition,
    'RECOVERY_REQUIRED',
  );
  const foreignCertificate=absentReceipt(local,{includeCertificate:true});
  foreignCertificate.observed!.absence_evidence={
    schema:'overcenter-absence-evidence-v1',
    kind:'kubernetes-complete-list-absence/v1',
    subject:{
      api_group:'',
      resource:'configmaps',
      namespace:'proof',
      name:'missing',
    },
    scope:{
      api_group:'',
      resource:'configmaps',
      namespace:'proof',
    },
    snapshot:{resource_version:'489'},
    completeness:{
      kind:'complete-list',
      page_count:3,
      terminal_continue:'',
    },
    provenance:{
      provider:'kubernetes',
      contract:'openapi-v3',
    },
  };
  assert.equal(
    projectReceipt(foreignCertificate,local).disposition,
    'RECOVERY_REQUIRED',
  );

  const eventual:Obligation={
    id:'absence',
    dependencies:[],
    packet:{},
    postcondition:{
      verifier:'eventually-consistent-file-content-equals/v1',
      path:'/provider/absence',
      content:'A',
    },
  };
  assert.equal(
    projectReceipt(absentReceipt(eventual),eventual).disposition,
    'RECOVERY_REQUIRED',
  );

  const github:Obligation={
    id:'absence',
    dependencies:[],
    packet:{},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/absence',
      expected_state:'success',
    },
  };
  assert.equal(
    projectReceipt(absentReceipt(github),github).disposition,
    'RECOVERY_REQUIRED',
  );
});

test('legacy receipt v4 preserves its historical absence projection',()=>{
  const local:Obligation={
    id:'absence',
    dependencies:[],
    packet:{},
    postcondition:{verifier:'file-content-equals/v1',path:'/provider/legacy',content:'A'},
  };
  const legacy=absentReceipt(local,{schema:LEGACY_RECEIPT_SCHEMA});
  legacy.observed={
    verifier:'file-content-equals/v1',
    mutation_certainty:'absent',
  };
  assert.equal(projectReceipt(legacy,local).disposition,'READY');
});

test('legacy v3 static-conflict history remains replayable but fail-closed',()=>{
  const status=(id:string,state:'success'|'failure'):Obligation=>({
    id,
    dependencies:[],
    packet:{},
    postcondition:{
      verifier:'github-commit-status/v1',
      provider:'github',
      repository_id:123,
      commit_sha:'a'.repeat(40),
      context:'overcenter/legacy-conflict',
      expected_state:state,
    },
  });
  const alpha=status('alpha','success');
  const beta=status('beta','failure');
  const projection=replayProjection([
    {
      commit:'define-alpha',
      parent:null,
      obligation:{
        schema:LEGACY_OBLIGATION_SCHEMA,
        kind:'defined',
        obligation:alpha,
      },
    },
    {
      commit:'define-beta',
      parent:'define-alpha',
      obligation:{
        schema:LEGACY_OBLIGATION_SCHEMA,
        kind:'defined',
        obligation:beta,
      },
    },
  ]);

  assert.equal(projection.state.obligations.alpha.id,'alpha');
  assert.equal(projection.state.obligations.beta.id,'beta');
  assert.equal(
    projection.project.claimabilityErrors.get(alpha.id),
    'UNORDERED_EFFECT_CONFLICT:alpha:beta',
  );
  assert.equal(
    projection.project.claimabilityErrors.get(beta.id),
    'UNORDERED_EFFECT_CONFLICT:alpha:beta',
  );
});
