import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Connection, Client } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.mjs';
import {
  externalEffectIdentity,
  realizationObligationKey,
} from '../../src/realization.ts';
import {
  verifyCertifiedKubernetesDeployment,
} from '../../src/providers/kubernetes-deployment.ts';
import {
  currentClusterAuthority,
  deploymentReader,
} from './kubernetes-read.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const TASK_QUEUE='release-evidence-substitution';
const IMAGE='registry.k8s.io/pause@sha256:7031c1b283388d2c2e09b57badb803c05ebed362dc88d84b480cc47f72a21097';
const namespace='staging';
const name='api';
const containerName='pause';
const authorityId=currentClusterAuthority();
const readDeployment=deploymentReader(authorityId);

function releaseContract(commit) {
  return {
    packet:{
      command:'deploy',
      provider:'kubernetes',
      coordinate:{authority_id:authorityId,namespace,name},
    },
    semantic_dependencies:[
      {selector:'source-commit',identity:`git:${commit}`},
      {selector:'image',identity:IMAGE},
    ],
    verifier_identity:'kubernetes-release-observation/v1',
    material_configuration:{authority_id:authorityId,namespace,name,container_name:containerName},
    source_inputs:{commit,image:IMAGE},
    acceptance_predicate:{
      kind:'sha256-equals/v1',
      expected_sha256:IMAGE.slice('registry.k8s.io/pause@sha256:'.length),
    },
    reuse_mode:'external-effect',
  };
}

function release(commit,runId,role,acceptedMarker) {
  const contract=releaseContract(commit);
  return {
    role,
    runId,
    commit,
    image:IMAGE,
    namespace,
    name,
    containerName,
    authorityId,
    obligationKey:realizationObligationKey(contract),
    effectIdentity:externalEffectIdentity(contract,runId),
    acceptedMarker,
  };
}

function expectation(release) {
  return {
    authority_id:release.authorityId,
    namespace:release.namespace,
    name:release.name,
    container_name:release.containerName,
    image:release.image,
    obligation_key:release.obligationKey,
    effect_identity:release.effectIdentity,
  };
}

async function waitForFile(path,timeoutMs=60_000) {
  const deadline=Date.now()+timeoutMs;
  while (Date.now()<deadline) {
    if (existsSync(path)) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${path}`);
}

const acceptedMarker=join(process.env.RUNNER_TEMP??here,'release-a-accepted.json');
const releaseA=release('a'.repeat(40),'run-a','interrupted',acceptedMarker);
const releaseB=release('b'.repeat(40),'run-b','replacement',acceptedMarker);

assert.equal(releaseA.image,releaseB.image);
assert.notEqual(releaseA.obligationKey,releaseB.obligationKey);
assert.notEqual(releaseA.effectIdentity,releaseB.effectIdentity);

execFileSync('kubectl',['create','namespace',namespace],{stdio:'ignore'});

const workerConnection=await NativeConnection.connect({address:'127.0.0.1:7233'});
const worker=await Worker.create({
  connection:workerConnection,
  taskQueue:TASK_QUEUE,
  workflowsPath:join(here,'workflows.mjs'),
  activities,
});
const workerRun=worker.run();

const clientConnection=await Connection.connect({address:'127.0.0.1:7233'});
const client=new Client({connection:clientConnection});

try {
  const handleA=await client.workflow.start('interruptedReleaseWorkflow',{
    taskQueue:TASK_QUEUE,
    workflowId:`release-a-${Date.now()}`,
    args:[releaseA],
  });

  await waitForFile(acceptedMarker);
  const acceptedA=JSON.parse(readFileSync(acceptedMarker,'utf8'));
  assert.equal(acceptedA.accepted,true);

  const handleB=await client.workflow.start('replacementReleaseWorkflow',{
    taskQueue:TASK_QUEUE,
    workflowId:`release-b-${Date.now()}`,
    args:[releaseB],
  });
  const resultB=await handleB.result();
  assert.equal(resultB.accepted,true);

  const resultA=await handleA.result();
  assert.equal(resultA.accepted,true);
  assert.equal(resultA.mode,'conventional-recovery');
  assert.equal(resultA.attempt,2);

  const read=readDeployment(namespace,name);
  const observed=read.observation.outcome.value;
  const annotations=observed.metadata.annotations??{};
  const exactA=verifyCertifiedKubernetesDeployment(expectation(releaseA),read);
  const exactB=verifyCertifiedKubernetesDeployment(expectation(releaseB),read);

  assert.equal(
    resultA.observed.effectIdentity,
    releaseB.effectIdentity,
    'Temporal recovery accepted the replacement execution as A',
  );
  assert.equal(annotations['overcenter.dev/effect-identity'],releaseB.effectIdentity);
  assert.equal(annotations['overcenter.dev/source-commit'],releaseB.commit);
  assert.equal(exactA.state,'rejected');
  assert.equal(exactA.reason,'KUBERNETES_DEPLOYMENT_REALIZATION_IDENTITY_MISMATCH');
  assert.equal(exactB.state,'verified');

  console.log(JSON.stringify({
    outcome:'FALSE_ATTRIBUTION_REPRODUCED',
    temporal:{
      release_a:{
        first_attempt_kubernetes_accepted:true,
        first_attempt_response:'lost',
        retry_attempt:resultA.attempt,
        recovery_result:'accepted',
      },
      release_b:{
        delete_recreate:true,
        workflow_result:'accepted',
      },
    },
    kubernetes:{
      current_uid:observed.metadata.uid,
      current_commit:annotations['overcenter.dev/source-commit'],
      current_effect_identity:annotations['overcenter.dev/effect-identity'],
      image:observed.spec.template.spec.containers[0].image,
      generation:observed.metadata.generation,
      observed_generation:observed.status.observedGeneration,
      available_replicas:observed.status.availableReplicas,
    },
    conventional:{
      release_a_settled:true,
      evidence_actually_belongs_to:'release-b',
    },
    overcenter_production_verifier:{
      release_a:exactA.state,
      release_a_reason:exactA.reason,
      release_b:exactB.state,
    },
  },null,2));
} finally {
  worker.shutdown();
  await workerRun;
  await clientConnection.close();
  await workerConnection.close();
}
