import assert from 'node:assert/strict';

type Route = 'main' | 'helper';
type Disposition = 'SAFE_RETRY' | 'RECOVERY_REQUIRED';
type Observation = { kind: string; value?: string | number | boolean };
type World = { id: string; route: Route; committed: boolean; noiseSeed: number };
type Metrics = { safeTotal: number; safeRetained: number; falseCertainty: number; total: number; agreement: number };

class Rng {
  state:number;
  constructor(seed:number){ this.state=seed>>>0 || 1; }
  next(){ let x=this.state; x^=x<<13; x^=x>>>17; x^=x<<5; this.state=x>>>0; return this.state/0x100000000; }
}

const NOISE_CLASSES=96;
const BROAD_CONTRACT = new Set<string>([
  'reservation','terminated','route','monitor-main-a','monitor-main-b','monitor-helper',
  ...Array.from({length:NOISE_CLASSES},(_,i)=>`noise-${i}`),
]);

function shuffle<T>(items:T[],seed:number):T[]{
  const out=[...items], rng=new Rng(seed);
  for(let i=out.length-1;i>0;i--){ const j=Math.floor(rng.next()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
  return out;
}

function capture(world:World, contract:Set<string>):Observation[]{
  const obs:Observation[]=[];
  if(contract.has('reservation')) obs.push({kind:'reservation',value:true});
  if(contract.has('terminated')) obs.push({kind:'terminated',value:true});
  if(contract.has('route')) obs.push({kind:'route',value:world.route});
  if(contract.has('monitor-main-a')) {
    obs.push({kind:'monitor-main-a-complete',value:true});
    if(world.route==='main' && world.committed) obs.push({kind:'send-main-a',value:true});
  }
  if(contract.has('monitor-main-b')) {
    obs.push({kind:'monitor-main-b-complete',value:true});
    if(world.route==='main' && world.committed) obs.push({kind:'send-main-b',value:true});
  }
  if(contract.has('monitor-helper')) {
    obs.push({kind:'monitor-helper-complete',value:true});
    if(world.route==='helper' && world.committed) obs.push({kind:'send-helper',value:true});
  }
  const rng=new Rng(world.noiseSeed);
  for(let i=0;i<NOISE_CLASSES;i++) if(contract.has(`noise-${i}`)) obs.push({kind:`noise-${i}`,value:Math.floor(rng.next()*1e9)});
  return shuffle(obs, world.noiseSeed ^ 0x9e3779b9);
}

function has(obs:Observation[], kind:string){ return obs.some(x=>x.kind===kind); }
function value(obs:Observation[],kind:string){ return obs.find(x=>x.kind===kind)?.value; }

function verify(obs:Observation[]):Disposition {
  if(!has(obs,'reservation') || !has(obs,'terminated')) return 'RECOVERY_REQUIRED';
  const route=value(obs,'route');
  if(route==='main') {
    const a=has(obs,'monitor-main-a-complete');
    const b=has(obs,'monitor-main-b-complete');
    if(!a && !b) return 'RECOVERY_REQUIRED';
    if((a && has(obs,'send-main-a')) || (b && has(obs,'send-main-b'))) return 'RECOVERY_REQUIRED';
    return 'SAFE_RETRY';
  }
  if(route==='helper') {
    if(!has(obs,'monitor-helper-complete')) return 'RECOVERY_REQUIRED';
    if(has(obs,'send-helper')) return 'RECOVERY_REQUIRED';
    return 'SAFE_RETRY';
  }
  return 'RECOVERY_REQUIRED';
}

function unsafeVerify(obs:Observation[]):Disposition {
  if(!has(obs,'reservation') || !has(obs,'terminated')) return 'RECOVERY_REQUIRED';
  const route=value(obs,'route');
  if(route==='main') return has(obs,'send-main-a') || has(obs,'send-main-b') ? 'RECOVERY_REQUIRED' : 'SAFE_RETRY';
  if(route==='helper') return has(obs,'send-helper') ? 'RECOVERY_REQUIRED' : 'SAFE_RETRY';
  return 'RECOVERY_REQUIRED';
}

function ddmin<T>(items:T[], predicate:(candidate:T[])=>boolean):T[]{
  let current=[...items], n=2;
  while(current.length>=2){
    const chunk=Math.ceil(current.length/n);
    let reduced=false;
    for(let start=0;start<current.length;start+=chunk){
      const candidate=current.slice(0,start).concat(current.slice(start+chunk));
      if(predicate(candidate)) { current=candidate; n=Math.max(2,n-1); reduced=true; break; }
    }
    if(!reduced){ if(n>=current.length) break; n=Math.min(current.length,n*2); }
  }
  let changed=true;
  while(changed){
    changed=false;
    for(let i=0;i<current.length;i++){
      const candidate=current.slice(0,i).concat(current.slice(i+1));
      if(predicate(candidate)){ current=candidate; changed=true; break; }
    }
  }
  return current;
}

function compileContract(witness:Observation[]):Set<string>{
  const c=new Set<string>();
  for(const o of witness){
    if(o.kind==='monitor-main-a-complete' || o.kind==='send-main-a') c.add('monitor-main-a');
    else if(o.kind==='monitor-main-b-complete' || o.kind==='send-main-b') c.add('monitor-main-b');
    else if(o.kind==='monitor-helper-complete' || o.kind==='send-helper') c.add('monitor-helper');
    else c.add(o.kind);
  }
  return c;
}

function makeWorlds(prefix:string, route:Route, count:number, offset:number):World[]{
  const worlds:World[]=[];
  for(let i=0;i<count;i++) worlds.push({id:`${prefix}-${i}`,route,committed:i%2===1,noiseSeed:offset+i*7919});
  return worlds;
}

function evaluate(worlds:World[], contract:Set<string>, verifier:(x:Observation[])=>Disposition):Metrics {
  let safeTotal=0,safeRetained=0,falseCertainty=0,agreement=0;
  for(const w of worlds){
    const broad=verify(capture(w,BROAD_CONTRACT));
    const got=verifier(capture(w,contract));
    if(broad==='SAFE_RETRY'){safeTotal++; if(got==='SAFE_RETRY')safeRetained++;}
    if(got==='SAFE_RETRY' && w.committed) falseCertainty++;
    if(got===broad) agreement++;
  }
  return {safeTotal,safeRetained,falseCertainty,total:worlds.length,agreement};
}

const training=makeWorlds('train-main','main',80,1000);
const trainingSafe=training.filter(w=>!w.committed);
const learned=new Set<string>();
const witnessShapes=new Set<string>();
let totalBroadObs=0,totalMinObs=0;

for(const w of trainingSafe){
  const broad=capture(w,BROAD_CONTRACT);
  assert.equal(verify(broad),'SAFE_RETRY');
  const min=ddmin(broad,candidate=>verify(candidate)==='SAFE_RETRY');
  assert.equal(verify(min),'SAFE_RETRY');
  for(let i=0;i<min.length;i++) assert.notEqual(verify(min.slice(0,i).concat(min.slice(i+1))),'SAFE_RETRY');
  const contract=compileContract(min);
  for(const item of contract) learned.add(item);
  witnessShapes.add([...contract].sort().join(','));
  totalBroadObs+=broad.length;
  totalMinObs+=min.length;
}

const sameRoute=makeWorlds('challenge-main','main',100,500000);
const unseenRoute=makeWorlds('challenge-helper','helper',100,900000);
const same=evaluate(sameRoute,learned,verify);
const unseen=evaluate(unseenRoute,learned,verify);
const unsafeUnseen=evaluate(unseenRoute,learned,unsafeVerify);

const reduction=1-(totalMinObs/totalBroadObs);
const sameRetention=same.safeRetained/same.safeTotal;
const unseenRetention=unseen.safeRetained/unseen.safeTotal;

assert.ok(reduction>=0.90);
assert.equal(same.falseCertainty,0);
assert.ok(sameRetention>=0.95);
assert.equal(unseen.falseCertainty,0);
assert.ok(unsafeUnseen.falseCertainty>0);
assert.ok(witnessShapes.size>1);

const strongHypothesis=unseenRetention>=0.95 && unseen.falseCertainty===0;

console.log(`training_safe_cases=${trainingSafe.length}`);
console.log(`broad_observations_mean=${(totalBroadObs/trainingSafe.length).toFixed(2)}`);
console.log(`minimized_observations_mean=${(totalMinObs/trainingSafe.length).toFixed(2)}`);
console.log(`observation_reduction_pct=${(reduction*100).toFixed(2)}`);
console.log(`distinct_minimal_witness_shapes=${witnessShapes.size}`);
console.log(`learned_capture_contract=${[...learned].sort().join(',')}`);
console.log(`same_route_recovery_retention_pct=${(sameRetention*100).toFixed(2)}`);
console.log(`same_route_false_certainty=${same.falseCertainty}`);
console.log(`unseen_route_recovery_retention_pct=${(unseenRetention*100).toFixed(2)}`);
console.log(`unseen_route_false_certainty=${unseen.falseCertainty}`);
console.log(`unsafe_unseen_false_certainty=${unsafeUnseen.falseCertainty}`);
console.log(`strong_hypothesis=${strongHypothesis?'SUPPORTED':'FALSIFIED'}`);
