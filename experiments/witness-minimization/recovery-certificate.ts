import assert from 'node:assert/strict';
import { canonicalDigest } from '../../src/digest.ts';

type Route='main'|'helper';
type Clause={required:string[]; alternatives:string[][]};
type ProofProgram={
  schema:'overcenter-learned-recovery-proof';
  topology_id:string;
  by_route:Record<Route,Clause>;
};
type ExecutionBinding={
  run_id:string;
  obligation_id:string;
  claimed_revision:string;
  claim_commit:string;
  obligation_key:string;
  execution_generation:number;
  execution_authority_commit:string;
  reservation_commit:string;
  route:Route;
};
type MonitorEvidence={
  id:'main-a'|'main-b'|'helper';
  complete:boolean;
  effect_observed:boolean;
};
type RecoveryWitness=ExecutionBinding&{
  topology_id:string;
  generation_terminated:boolean;
  monitors:MonitorEvidence[];
};
type RecoveryAdmission=ExecutionBinding&{
  topology_id:string;
  proof_digest:string;
  witness_digest:string;
};

const TOPOLOGY={
  schema:'overcenter-mutation-topology',
  routes:{
    main:{monitors:['main-a','main-b']},
    helper:{monitors:['helper']},
  },
} as const;
const TOPOLOGY_ID=canonicalDigest(TOPOLOGY);

const PROOF:ProofProgram={
  schema:'overcenter-learned-recovery-proof',
  topology_id:TOPOLOGY_ID,
  by_route:{
    main:{
      required:['generation-terminated','reservation-bound','route:main'],
      alternatives:[['main-a-clear'],['main-b-clear']],
    },
    helper:{
      required:['generation-terminated','helper-clear','reservation-bound','route:helper'],
      alternatives:[],
    },
  },
};
const PROOF_DIGEST=canonicalDigest(PROOF);

function sameExecution(left:ExecutionBinding,right:ExecutionBinding):boolean{
  return left.run_id===right.run_id
    && left.obligation_id===right.obligation_id
    && left.claimed_revision===right.claimed_revision
    && left.claim_commit===right.claim_commit
    && left.obligation_key===right.obligation_key
    && left.execution_generation===right.execution_generation
    && left.execution_authority_commit===right.execution_authority_commit
    && left.reservation_commit===right.reservation_commit
    && left.route===right.route;
}

function semanticAtoms(expected:ExecutionBinding,witness:RecoveryWitness):Set<string>{
  const atoms=new Set<string>();
  if(sameExecution(expected,witness)) atoms.add('reservation-bound');
  if(
    witness.generation_terminated
    && witness.execution_generation===expected.execution_generation
    && witness.execution_authority_commit===expected.execution_authority_commit
  ) atoms.add('generation-terminated');
  if(witness.route===expected.route) atoms.add(`route:${expected.route}`);

  const allowed=new Set(TOPOLOGY.routes[expected.route].monitors as readonly string[]);
  for(const monitor of witness.monitors){
    if(!allowed.has(monitor.id)) continue;
    if(!monitor.complete || monitor.effect_observed) continue;
    atoms.add(`${monitor.id}-clear`);
  }
  return atoms;
}

function evaluateClause(clause:Clause,atoms:Set<string>):boolean{
  if(!clause.required.every(atom=>atoms.has(atom))) return false;
  if(clause.alternatives.length===0) return true;
  return clause.alternatives.some(group=>group.every(atom=>atoms.has(atom)));
}

function prove(expected:ExecutionBinding,witness:RecoveryWitness,proof:ProofProgram):boolean{
  if(witness.topology_id!==proof.topology_id) return false;
  if(proof.topology_id!==TOPOLOGY_ID) return false;
  return evaluateClause(proof.by_route[expected.route],semanticAtoms(expected,witness));
}

const SECRET=Symbol('recovery-certificate');
type CertificateBindings=RecoveryAdmission;

class RecoveryCertificate {
  #bindings:CertificateBindings;
  constructor(secret:symbol,bindings:CertificateBindings){
    if(secret!==SECRET) throw new Error('RECOVERY_CERTIFICATE_FORGERY');
    this.#bindings=Object.freeze(structuredClone(bindings));
    Object.freeze(this);
  }
  matches(expected:RecoveryAdmission):boolean{
    const b=this.#bindings;
    return sameExecution(b,expected)
      && b.topology_id===expected.topology_id
      && b.proof_digest===expected.proof_digest
      && b.witness_digest===expected.witness_digest;
  }
}

function mintRecoveryCertificate(
  expected:ExecutionBinding,
  witness:RecoveryWitness,
  proof:ProofProgram=PROOF,
):{certificate:RecoveryCertificate;admission:RecoveryAdmission}{
  if(!sameExecution(expected,witness)) throw new Error('RECOVERY_WITNESS_EXECUTION_MISMATCH');
  if(witness.topology_id!==TOPOLOGY_ID) throw new Error('RECOVERY_TOPOLOGY_MISMATCH');
  if(proof.topology_id!==TOPOLOGY_ID) throw new Error('RECOVERY_PROOF_TOPOLOGY_MISMATCH');
  if(!prove(expected,witness,proof)) throw new Error('RECOVERY_PROOF_NOT_SATISFIED');

  const admission:RecoveryAdmission={
    ...expected,
    topology_id:TOPOLOGY_ID,
    proof_digest:canonicalDigest(proof),
    witness_digest:canonicalDigest(witness),
  };
  return {
    certificate:new RecoveryCertificate(SECRET,admission),
    admission,
  };
}

const consumed=new WeakSet<RecoveryCertificate>();
function consumeRecoveryCertificate(
  certificate:RecoveryCertificate,
  expected:RecoveryAdmission,
):void{
  if(!(certificate instanceof RecoveryCertificate)) {
    throw new Error('RECOVERY_CERTIFICATE_INVALID');
  }
  if(consumed.has(certificate)) throw new Error('RECOVERY_CERTIFICATE_REPLAY');
  if(!certificate.matches(expected)) throw new Error('RECOVERY_CERTIFICATE_BINDING_MISMATCH');
  if(expected.topology_id!==TOPOLOGY_ID) throw new Error('RECOVERY_TOPOLOGY_STALE');
  if(expected.proof_digest!==PROOF_DIGEST) throw new Error('RECOVERY_PROOF_STALE');
  consumed.add(certificate);
}

const BASE:ExecutionBinding={
  run_id:'run-A',
  obligation_id:'obligation-A',
  claimed_revision:'revision-A',
  claim_commit:'claim-A',
  obligation_key:'obligation-key-A',
  execution_generation:7,
  execution_authority_commit:'authority-A-g7',
  reservation_commit:'reservation-A-g7',
  route:'main',
};

function witness(
  overrides:Partial<RecoveryWitness>={},
):RecoveryWitness{
  return {
    ...BASE,
    topology_id:TOPOLOGY_ID,
    generation_terminated:true,
    monitors:[
      {id:'main-a',complete:true,effect_observed:false},
      {id:'main-b',complete:true,effect_observed:false},
    ],
    ...overrides,
  };
}

function changed<T extends object,K extends keyof T>(value:T,key:K,next:T[K]):T{
  return {...value,[key]:next};
}

// Positive proof paths.
const viaA=witness({monitors:[
  {id:'main-a',complete:true,effect_observed:false},
  {id:'main-b',complete:false,effect_observed:false},
]});
const viaB=witness({monitors:[
  {id:'main-a',complete:false,effect_observed:false},
  {id:'main-b',complete:true,effect_observed:false},
]});
assert.equal(prove(BASE,viaA,PROOF),true);
assert.equal(prove(BASE,viaB,PROOF),true);

// Absence has no force without completeness; a witnessed effect invalidates clear.
assert.equal(prove(BASE,witness({monitors:[]}),PROOF),false);
assert.equal(prove(BASE,witness({monitors:[
  {id:'main-a',complete:true,effect_observed:true},
  {id:'main-b',complete:false,effect_observed:false},
]}),PROOF),false);

// Minting rejects cross-execution substitution before a certificate exists.
const mintMutations:Array<[string,(w:RecoveryWitness)=>RecoveryWitness]>=[
  ['run_id',w=>changed(w,'run_id','run-B')],
  ['obligation_id',w=>changed(w,'obligation_id','obligation-B')],
  ['claimed_revision',w=>changed(w,'claimed_revision','revision-B')],
  ['claim_commit',w=>changed(w,'claim_commit','claim-B')],
  ['obligation_key',w=>changed(w,'obligation_key','obligation-key-B')],
  ['execution_generation',w=>changed(w,'execution_generation',8)],
  ['execution_authority_commit',w=>changed(w,'execution_authority_commit','authority-A-g8')],
  ['reservation_commit',w=>changed(w,'reservation_commit','reservation-A-g8')],
  ['route',w=>changed(w,'route','helper')],
  ['topology_id',w=>changed(w,'topology_id','0'.repeat(64))],
  ['generation_terminated',w=>changed(w,'generation_terminated',false)],
  ['monitor_completeness',w=>changed(w,'monitors',[])],
  ['effect_observed',w=>changed(w,'monitors',[
    {id:'main-a',complete:true,effect_observed:true},
    {id:'main-b',complete:false,effect_observed:false},
  ])],
];
let mintRejected=0;
for(const [,mutate] of mintMutations){
  assert.throws(()=>mintRecoveryCertificate(BASE,mutate(viaA)));
  mintRejected++;
}

// Proof/topology substitution is rejected.
const wrongTopologyProof:ProofProgram={...PROOF,topology_id:'f'.repeat(64)};
assert.throws(()=>mintRecoveryCertificate(BASE,viaA,wrongTopologyProof));
mintRejected++;

const relaxedProof:ProofProgram={
  ...PROOF,
  by_route:{
    ...PROOF.by_route,
    main:{required:['reservation-bound'],alternatives:[]},
  },
};
const relaxedProofWithCurrentTopology={...relaxedProof,topology_id:TOPOLOGY_ID};
const relaxedMint=mintRecoveryCertificate(BASE,viaA,relaxedProofWithCurrentTopology);
assert.notEqual(relaxedMint.admission.proof_digest,PROOF_DIGEST);

// Consumption binds the minted proof and witness to the current admitted context.
const consumeMutationKeys:(keyof RecoveryAdmission)[]=[
  'run_id',
  'obligation_id',
  'claimed_revision',
  'claim_commit',
  'obligation_key',
  'execution_generation',
  'execution_authority_commit',
  'reservation_commit',
  'route',
  'topology_id',
  'proof_digest',
  'witness_digest',
];
const replacements:Record<keyof RecoveryAdmission,string|number>={
  run_id:'run-Z',
  obligation_id:'obligation-Z',
  claimed_revision:'revision-Z',
  claim_commit:'claim-Z',
  obligation_key:'obligation-key-Z',
  execution_generation:99,
  execution_authority_commit:'authority-Z',
  reservation_commit:'reservation-Z',
  route:'helper',
  topology_id:'e'.repeat(64),
  proof_digest:'d'.repeat(64),
  witness_digest:'c'.repeat(64),
};

let consumeRejected=0;
for(const key of consumeMutationKeys){
  const fresh=mintRecoveryCertificate(BASE,viaA);
  const bad={...fresh.admission,[key]:replacements[key]} as RecoveryAdmission;
  assert.throws(()=>consumeRecoveryCertificate(fresh.certificate,bad));
  consumeRejected++;
}

// A certificate minted from an unadmitted learned proof cannot be consumed
// where the production policy expects the admitted proof digest.
assert.throws(()=>consumeRecoveryCertificate(
  relaxedMint.certificate,
  {...relaxedMint.admission,proof_digest:PROOF_DIGEST},
));
consumeRejected++;

// Constructor forgery and single-use replay both fail.
assert.throws(()=>new RecoveryCertificate(Symbol('attacker'),mintRecoveryCertificate(BASE,viaA).admission));
const once=mintRecoveryCertificate(BASE,viaA);
consumeRecoveryCertificate(once.certificate,once.admission);
assert.throws(()=>consumeRecoveryCertificate(once.certificate,once.admission));

// Witness content is cryptographically bound: a different complete witness
// needs a separately minted certificate even when it proves the same clause.
const a=mintRecoveryCertificate(BASE,viaA);
const b=mintRecoveryCertificate(BASE,viaB);
assert.notEqual(a.admission.witness_digest,b.admission.witness_digest);
assert.throws(()=>consumeRecoveryCertificate(a.certificate,b.admission));

// Topology identity changes when the trusted route envelope changes.
const changedTopologyId=canonicalDigest({
  ...TOPOLOGY,
  routes:{...TOPOLOGY.routes,main:{monitors:['main-a','main-b','main-c']}},
});
assert.notEqual(changedTopologyId,TOPOLOGY_ID);
const topologyStale=mintRecoveryCertificate(BASE,viaA);
assert.throws(()=>consumeRecoveryCertificate(
  topologyStale.certificate,
  {...topologyStale.admission,topology_id:changedTopologyId},
));

console.log(`topology_id=${TOPOLOGY_ID}`);
console.log(`proof_digest=${PROOF_DIGEST}`);
console.log('bound_identity_fields=run_id,obligation_id,claimed_revision,claim_commit,obligation_key,execution_generation,execution_authority_commit,reservation_commit,route');
console.log(`mint_hostile_cases=${mintMutations.length+1}`);
console.log(`mint_hostile_rejected=${mintRejected}`);
console.log(`consume_hostile_cases=${consumeMutationKeys.length+1}`);
console.log(`consume_hostile_rejected=${consumeRejected}`);
console.log('constructor_forgery_rejected=true');
console.log('single_use_replay_rejected=true');
console.log('equivalent_witness_substitution_rejected=true');
console.log('topology_change_invalidates_certificate=true');
console.log('proof_policy_substitution_rejected=true');
console.log('false_certainty=0');
