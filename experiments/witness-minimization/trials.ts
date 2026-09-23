import assert from 'node:assert/strict';

type Route = 'main' | 'helper';
type Disposition = 'SAFE_RETRY' | 'RECOVERY_REQUIRED';
type Observation = { kind: string; value?: string | number | boolean };
type World = { route: Route; committed: boolean; seed: number };

class Rng {
  state:number;
  constructor(seed:number){ this.state=seed>>>0 || 1; }
  next(){ let x=this.state; x^=x<<13; x^=x>>>17; x^=x<<5; this.state=x>>>0; return this.state/0x100000000; }
}

const NOISE=96;
const BROAD = new Set<string>([
  'reservation','terminated','route','monitor-main-a','monitor-main-b','monitor-helper',
  ...Array.from({length:NOISE},(_,i)=>`noise-${i}`),
]);

function shuffle<T>(items:T[], seed:number):T[] {
  const out=[...items], rng=new Rng(seed);
  for(let i=out.length-1;i>0;i--){ const j=Math.floor(rng.next()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
  return out;
}

function capture(w:World, contract:Set<string>):Observation[] {
  const o:Observation[]=[];
  if(contract.has('reservation')) o.push({kind:'reservation',value:true});
  if(contract.has('terminated')) o.push({kind:'terminated',value:true});
  if(contract.has('route')) o.push({kind:'route',value:w.route});
  if(contract.has('monitor-main-a')) {
    o.push({kind:'monitor-main-a-complete',value:true});
    if(w.route==='main' && w.committed) o.push({kind:'send-main-a',value:true});
  }
  if(contract.has('monitor-main-b')) {
    o.push({kind:'monitor-main-b-complete',value:true});
    if(w.route==='main' && w.committed) o.push({kind:'send-main-b',value:true});
  }
  if(contract.has('monitor-helper')) {
    o.push({kind:'monitor-helper-complete',value:true});
    if(w.route==='helper' && w.committed) o.push({kind:'send-helper',value:true});
  }
  const rng=new Rng(w.seed);
  for(let i=0;i<NOISE;i++) if(contract.has(`noise-${i}`)) {
    o.push({kind:`noise-${i}`,value:Math.floor(rng.next()*1e9)});
  }
  return shuffle(o,w.seed^0x7f4a7c15);
}

function has(o:Observation[],kind:string){ return o.some(x=>x.kind===kind); }
function val(o:Observation[],kind:string){ return o.find(x=>x.kind===kind)?.value; }

function verify(o:Observation[]):Disposition {
  if(!has(o,'reservation') || !has(o,'terminated')) return 'RECOVERY_REQUIRED';
  const route=val(o,'route');
  if(route==='main'){
    const a=has(o,'monitor-main-a-complete'), b=has(o,'monitor-main-b-complete');
    if(!a && !b) return 'RECOVERY_REQUIRED';
    if((a && has(o,'send-main-a')) || (b && has(o,'send-main-b'))) return 'RECOVERY_REQUIRED';
    return 'SAFE_RETRY';
  }
  if(route==='helper'){
    if(!has(o,'monitor-helper-complete')) return 'RECOVERY_REQUIRED';
    if(has(o,'send-helper')) return 'RECOVERY_REQUIRED';
    return 'SAFE_RETRY';
  }
  return 'RECOVERY_REQUIRED';
}

function ddmin<T>(items:T[], predicate:(candidate:T[])=>boolean):T[] {
  let current=[...items], n=2;
  while(current.length>=2){
    const size=Math.ceil(current.length/n);
    let reduced=false;
    for(let start=0;start<current.length;start+=size){
      const candidate=current.slice(0,start).concat(current.slice(start+size));
      if(predicate(candidate)){ current=candidate; n=Math.max(2,n-1); reduced=true; break; }
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

function contractFor(o:Observation[]):Set<string>{
  const c=new Set<string>();
  for(const x of o){
    if(x.kind==='monitor-main-a-complete'||x.kind==='send-main-a') c.add('monitor-main-a');
    else if(x.kind==='monitor-main-b-complete'||x.kind==='send-main-b') c.add('monitor-main-b');
    else if(x.kind==='monitor-helper-complete'||x.kind==='send-helper') c.add('monitor-helper');
    else c.add(x.kind);
  }
  return c;
}

function safe(route:Route,n:number,base:number):World[]{
  return Array.from({length:n},(_,i)=>({route,committed:false,seed:base+i*104729}));
}
function mixed(route:Route,n:number,base:number):World[]{
  return Array.from({length:n},(_,i)=>({route,committed:i%2===1,seed:base+i*65537}));
}
function learnSafe(worlds:World[]):Set<string>{
  const learned=new Set<string>();
  for(const w of worlds){
    const full=capture(w,BROAD);
    assert.equal(verify(full),'SAFE_RETRY');
    const min=ddmin(full,c=>verify(c)==='SAFE_RETRY');
    for(let i=0;i<min.length;i++) assert.notEqual(verify(min.slice(0,i).concat(min.slice(i+1))),'SAFE_RETRY');
    for(const x of contractFor(min)) learned.add(x);
  }
  return learned;
}
function metrics(worlds:World[],contract:Set<string>){
  let safe=0,retained=0,falseCertainty=0,agreement=0;
  for(const w of worlds){
    const broad=verify(capture(w,BROAD));
    const narrow=verify(capture(w,contract));
    if(broad==='SAFE_RETRY'){safe++; if(narrow==='SAFE_RETRY') retained++;}
    if(narrow==='SAFE_RETRY'&&w.committed) falseCertainty++;
    if(narrow===broad) agreement++;
  }
  return {safe,retained,falseCertainty,agreement,total:worlds.length};
}
function pct(n:number,d:number){ return d===0?0:100*n/d; }

// Trial 1: route exposure sweep.
const baseTraining=safe('main',40,10000);
const helperChallenge=mixed('helper',200,200000);
console.log('trial=route-exposure-sweep');
for(const count of [0,1,2,4,8,16]){
  const learned=learnSafe(baseTraining.concat(safe('helper',count,300000+count*1000)));
  const m=metrics(helperChallenge,learned);
  const retention=pct(m.retained,m.safe);
  assert.equal(m.falseCertainty,0);
  if(count===0) assert.equal(retention,0);
  else assert.equal(retention,100);
  console.log(`helper_safe_training=${count} helper_recovery_retention_pct=${retention.toFixed(2)} learned_monitor_helper=${learned.has('monitor-helper')}`);
}

// Trial 2: minimization order / redundant proof stability.
console.log('trial=minimization-stability');
const shapes=new Map<string,number>();
let core:Set<string>|undefined;
let union=new Set<string>();
for(const w of safe('main',500,700000)){
  const min=ddmin(capture(w,BROAD),c=>verify(c)==='SAFE_RETRY');
  const c=contractFor(min);
  const key=[...c].sort().join(',');
  shapes.set(key,(shapes.get(key)??0)+1);
  if(!core) core=new Set(c); else core=new Set([...core].filter(x=>c.has(x)));
  for(const x of c) union.add(x);
}
assert.equal(shapes.size,2);
assert.deepEqual([...core!].sort(),['reservation','route','terminated']);
assert.deepEqual([...union].sort(),['monitor-main-a','monitor-main-b','reservation','route','terminated']);
for(const [shape,count] of [...shapes.entries()].sort()) console.log(`shape=${shape} count=${count}`);
console.log(`stable_core=${[...core!].sort().join(',')}`);
console.log(`shape_union=${[...union].sort().join(',')}`);

// Trial 3: fail-closed outcomes are not useful minimization targets.
console.log('trial=outcome-asymmetry');
let rrTotal=0;
for(const w of mixed('helper',100,900000).filter(x=>x.committed)){
  const full=capture(w,BROAD);
  assert.equal(verify(full),'RECOVERY_REQUIRED');
  const min=ddmin(full,c=>verify(c)==='RECOVERY_REQUIRED');
  rrTotal+=min.length;
}
const rrMean=rrTotal/50;
assert.equal(rrMean,0);
console.log(`committed_helper_cases=50 recovery_required_minimized_observations_mean=${rrMean.toFixed(2)}`);
console.log('interpretation=generic_RECOVERY_REQUIRED_is_default_and_minimizes_to_no_evidence');

// Trial 4: guarded promotion with an independently complete route inventory.
console.log('trial=guarded-promotion');
const historical=learnSafe(baseTraining);
const guarded=new Set(historical);
guarded.add('monitor-helper'); // supplied by independent route inventory, not historical witness frequency.
const both=mixed('main',200,1100000).concat(mixed('helper',200,1300000));
const guardedMetrics=metrics(both,guarded);
const guardedRetention=pct(guardedMetrics.retained,guardedMetrics.safe);
const classReduction=100*(1-guarded.size/BROAD.size);
assert.equal(guardedRetention,100);
assert.equal(guardedMetrics.falseCertainty,0);
console.log(`guarded_contract=${[...guarded].sort().join(',')}`);
console.log(`guarded_capture_classes=${guarded.size} broad_capture_classes=${BROAD.size} capture_class_reduction_pct=${classReduction.toFixed(2)}`);
console.log(`guarded_recovery_retention_pct=${guardedRetention.toFixed(2)} guarded_false_certainty=${guardedMetrics.falseCertainty}`);

// Trial 5: shadow sampling discovery latency for a 1% hidden route.
console.log('trial=shadow-discovery');
function geometricQuantile(prob:number,q:number){
  return Math.ceil(Math.log(1-q)/Math.log(1-prob));
}
const helperRate=0.01;
for(const shadowRate of [0.001,0.005,0.01,0.05,0.1]){
  const anyHelper=helperRate*shadowRate;
  const safeHelper=helperRate*0.5*shadowRate;
  const noveltyMedian=geometricQuantile(anyHelper,0.5);
  const noveltyP95=geometricQuantile(anyHelper,0.95);
  const witnessMedian=geometricQuantile(safeHelper,0.5);
  const witnessP95=geometricQuantile(safeHelper,0.95);
  console.log(`shadow_rate_pct=${(shadowRate*100).toFixed(1)} route_novelty_median_events=${noveltyMedian} route_novelty_p95_events=${noveltyP95} safe_witness_median_events=${witnessMedian} safe_witness_p95_events=${witnessP95}`);
}
