import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDigest, sha256 } from '../../src/digest.ts';
import {
  realizationObligationKey,
  type RealizationContract,
} from '../../src/realization.ts';

type Coordinate={
  cluster:string;
  namespace:string;
  name:string;
};

type ReleaseIntent={
  commit:string;
  imageSha256:string;
  coordinate:Coordinate;
};

type CertifiedDeploymentObservation={
  coordinate:Coordinate;
  uid:string;
  generation:number;
  observedGeneration:number;
  imageSha256:string;
  desiredReplicas:number;
  readyReplicas:number;
  obligationKey:string;
  effectIdentity:string;
};

const IMAGE=sha256('identical runtime image bytes');
const coordinate:Coordinate={
  cluster:'kind:release-proof',
  namespace:'staging',
  name:'api',
};

function releaseContract(intent:ReleaseIntent):RealizationContract {
  return {
    packet:{
      command:'deploy',
      provider:'kubernetes',
      coordinate:intent.coordinate,
    },
    semantic_dependencies:[
      {selector:'source-commit',identity:`git:${intent.commit}`},
      {selector:'image',identity:`sha256:${intent.imageSha256}`},
    ],
    verifier_identity:'kubernetes-release-observation/v1',
    material_configuration:{coordinate:intent.coordinate},
    source_inputs:{
      commit:intent.commit,
      image_sha256:intent.imageSha256,
    },
    acceptance_predicate:{
      kind:'sha256-equals/v1',
      expected_sha256:intent.imageSha256,
    },
    reuse_mode:'external-effect',
  };
}

function obligationKey(intent:ReleaseIntent):string {
  return realizationObligationKey(releaseContract(intent));
}

function effectIdentity(intent:ReleaseIntent,runId:string):string {
  return canonicalDigest({
    schema:'overcenter-external-effect-identity/v1',
    obligation_key:obligationKey(intent),
    run_id:runId,
  });
}

function sameCoordinate(a:Coordinate,b:Coordinate):boolean {
  return a.cluster===b.cluster
    && a.namespace===b.namespace
    && a.name===b.name;
}

// This is deliberately not a strawman "just check Ready" implementation.
// It models common careful application logic: exact coordinate, immutable image,
// current generation, and health. What it lacks is execution provenance.
function conventionalRecoveryAccepts(
  intent:ReleaseIntent,
  observed:CertifiedDeploymentObservation,
):boolean {
  return sameCoordinate(intent.coordinate,observed.coordinate)
    && intent.imageSha256===observed.imageSha256
    && observed.observedGeneration===observed.generation
    && observed.desiredReplicas>0
    && observed.readyReplicas===observed.desiredReplicas;
}

function exactEvidenceAccepts(
  intent:ReleaseIntent,
  runId:string,
  observed:CertifiedDeploymentObservation,
):boolean {
  return conventionalRecoveryAccepts(intent,observed)
    && observed.obligationKey===obligationKey(intent)
    && observed.effectIdentity===effectIdentity(intent,runId);
}

function effectBindingMutantAccepts(
  intent:ReleaseIntent,
  _runId:string,
  observed:CertifiedDeploymentObservation,
):boolean {
  return conventionalRecoveryAccepts(intent,observed)
    && observed.obligationKey===obligationKey(intent);
}

function observationFor(
  intent:ReleaseIntent,
  runId:string,
  uid:string,
):CertifiedDeploymentObservation {
  return {
    coordinate:intent.coordinate,
    uid,
    generation:1,
    observedGeneration:1,
    imageSha256:intent.imageSha256,
    desiredReplicas:3,
    readyReplicas:3,
    obligationKey:obligationKey(intent),
    effectIdentity:effectIdentity(intent,runId),
  };
}

test('different release with identical image can be falsely credited to the interrupted release',()=>{
  const releaseA:ReleaseIntent={
    commit:'a'.repeat(40),
    imageSha256:IMAGE,
    coordinate,
  };
  const releaseB:ReleaseIntent={
    commit:'b'.repeat(40),
    imageSha256:IMAGE,
    coordinate,
  };

  // A's Kubernetes mutation was accepted but its Activity response was lost.
  // B later delete/recreated the same Deployment coordinate and became healthy.
  const current=observationFor(releaseB,'run-b','uid-b');

  assert.equal(conventionalRecoveryAccepts(releaseA,current),true);
  assert.notEqual(obligationKey(releaseA),obligationKey(releaseB));
  assert.equal(exactEvidenceAccepts(releaseA,'run-a',current),false);
});

test('effect identity is necessary even when the semantic release obligation is identical',()=>{
  const releaseA:ReleaseIntent={
    commit:'a'.repeat(40),
    imageSha256:IMAGE,
    coordinate,
  };

  // Same semantic desired state, different authorized execution. This is the
  // delete/recreate/retry case in which desired-state equality cannot prove
  // which effect produced the observed object.
  const replacement=observationFor(releaseA,'run-replacement','uid-replacement');

  assert.equal(conventionalRecoveryAccepts(releaseA,replacement),true);
  assert.equal(
    replacement.obligationKey,
    obligationKey(releaseA),
    'semantic obligation is intentionally identical',
  );

  assert.equal(
    effectBindingMutantAccepts(releaseA,'run-original',replacement),
    true,
    'dropping only effect binding recreates the false attribution',
  );
  assert.equal(
    exactEvidenceAccepts(releaseA,'run-original',replacement),
    false,
    'exact effect identity rejects valid evidence for the wrong execution',
  );
});

test('exact evidence still accepts the intended healthy realization',()=>{
  const releaseA:ReleaseIntent={
    commit:'a'.repeat(40),
    imageSha256:IMAGE,
    coordinate,
  };
  const intended=observationFor(releaseA,'run-a','uid-a');

  assert.equal(conventionalRecoveryAccepts(releaseA,intended),true);
  assert.equal(exactEvidenceAccepts(releaseA,'run-a',intended),true);
});

test('external release effects cannot be reused as historical content-addressed realizations',()=>{
  const releaseA:ReleaseIntent={
    commit:'a'.repeat(40),
    imageSha256:IMAGE,
    coordinate,
  };
  const contract=releaseContract(releaseA);

  assert.equal(contract.reuse_mode,'external-effect');
  assert.equal(
    obligationKey(releaseA),
    realizationObligationKey(contract),
    'the experiment reuses the production semantic obligation identity',
  );
});
