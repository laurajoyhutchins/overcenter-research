import assert from 'node:assert/strict';

type Route='main'|'helper';
type Observation={kind:string; value?:string|boolean|number};
type MonitorSpec={capability:string; complete:string; effect:string};
type RouteSpec={route:Route; monitors:readonly MonitorSpec[]};
type Clause={required:string[]; alternatives:string[][]};
type LearnedProof={byRoute:Record<Route,Clause>};

const TOPOLOGY:Record<Route,RouteSpec>={
  main:{
    route:'main',
    monitors:[
      {capability:'main-a-clear',complete:'monitor-main-a-complete',effect:'send-main-a'},
      {capability:'main-b-clear',complete:'monitor-main-b-complete',effect:'send-main-b'},
    ],
  },
  helper:{
    route:'helper',
    monitors:[
      {capability:'helper-clear',complete:'monitor-helper-complete',effect:'send-helper'},
    ],
  },
};

class Rng {
  state:number;
  constructor(seed:number){this.state=seed>>>0||1;}
  next(){let x=this.state;x^=x<<13;x^=x>>>17;x^=x<<5;this.state=x>>>0;return this.state/0x100000000;}
}

function shuffle<T>(items:T[],seed:number):T[]{
  const out=[...items],rng=new Rng(seed);
  for(let i=out.length-1;i>0;i--){const j=Math.floor(rng.next()*(i+1));[out[i],out[j]]=[out[j],out[i]];}
  return out;
}

function has(obs:Observation[],kind:string){return obs.some(x=>x.kind===kind);}
function routeOf(obs:Observation[]):Route|null {
  const value=obs.find(x=>x.kind==='route')?.value;
  return value==='main'||value==='helper'?value:null;
}

function deriveAtoms(obs:Observation[]):Set<string>{
  const atoms=new Set<string>();
  if(has(obs,'reservation')) atoms.add('reservation-bound');
  if(has(obs,'terminated')) atoms.add('generation-terminated');
  const route=routeOf(obs);
  if(!route) return atoms;
  atoms.add(`route:${route}`);
  for(const monitor of TOPOLOGY[route].monitors){
    if(has(obs,monitor.complete) && !has(obs,monitor.effect)) atoms.add(monitor.capability);
  }
  return atoms;
}

function proveNoEffect(obs:Observation[]):boolean{
  const atoms=deriveAtoms(obs);
  const route=routeOf(obs);
  if(!route) return false;
  if(!atoms.has('reservation-bound')||!atoms.has('generation-terminated')||!atoms.has(`route:${route}`)) return false;
  return TOPOLOGY[route].monitors.some(m=>atoms.has(m.capability));
}

function ddmin<T>(items:T[],predicate:(candidate:T[])=>boolean):T[]{
  let current=[...items],n=2;
  while(current.length>=2){
    const size=Math.ceil(current.length/n);
    let reduced=false;
    for(let start=0;start<current.length;start+=size){
      const candidate=current.slice(0,start).concat(current.slice(start+size));
      if(predicate(candidate)){current=candidate;n=Math.max(2,n-1);reduced=true;break;}
    }
    if(!reduced){if(n>=current.length)break;n=Math.min(current.length,n*2);}
  }
  let changed=true;
  while(changed){
    changed=false;
    for(let i=0;i<current.length;i++){
      const candidate=current.slice(0,i).concat(current.slice(i+1));
      if(predicate(candidate)){current=candidate;changed=true;break;}
    }
  }
  return current;
}

function makeSafe(route:Route,seed:number):Observation[]{
  const obs:Observation[]=[
    {kind:'reservation',value:true},
    {kind:'terminated',value:true},
    {kind:'route',value:route},
  ];
  for(const spec of Object.values(TOPOLOGY)){
    for(const monitor of spec.monitors) obs.push({kind:monitor.complete,value:true});
  }
  const rng=new Rng(seed);
  for(let i=0;i<96;i++) obs.push({kind:`noise-${i}`,value:Math.floor(rng.next()*1e9)});
  return shuffle(obs,seed^0x51f15e);
}

function learnRoute(route:Route,seeds:number[]):Clause{
  const clauses:string[][]=[];
  for(const seed of seeds){
    const full=makeSafe(route,seed);
    assert.equal(proveNoEffect(full),true);
    const min=ddmin(full,proveNoEffect);
    assert.equal(proveNoEffect(min),true);
    for(let i=0;i<min.length;i++) assert.equal(proveNoEffect(min.slice(0,i).concat(min.slice(i+1))),false);
    clauses.push([...deriveAtoms(min)].sort());
  }

  const required=clauses.reduce(
    (acc,atoms)=>acc.filter(atom=>atoms.includes(atom)),
    [...clauses[0]],
  ).sort();

  const alternativesMap=new Map<string,string[]>();
  for(const atoms of clauses){
    const residual=atoms.filter(atom=>!required.includes(atom)).sort();
    if(residual.length===0) continue;
    const key=residual.join('&');
    alternativesMap.set(key,residual);
  }
  const alternatives=[...alternativesMap.values()].sort((a,b)=>a.join('&').localeCompare(b.join('&')));
  return {required,alternatives};
}

function learnProof():LearnedProof{
  return {
    byRoute:{
      main:learnRoute('main',Array.from({length:500},(_,i)=>1000+i*7919)),
      helper:learnRoute('helper',Array.from({length:100},(_,i)=>900000+i*104729)),
    },
  };
}

function evaluateClause(clause:Clause,atoms:Set<string>):boolean{
  if(!clause.required.every(atom=>atoms.has(atom))) return false;
  if(clause.alternatives.length===0) return true;
  return clause.alternatives.some(group=>group.every(atom=>atoms.has(atom)));
}

function evaluateLearned(proof:LearnedProof,obs:Observation[]):boolean{
  const route=routeOf(obs);
  if(!route) return false;
  return evaluateClause(proof.byRoute[route],deriveAtoms(obs));
}

function renderClause(clause:Clause):string{
  const left=clause.required.join(' & ');
  if(clause.alternatives.length===0) return left;
  const alt=clause.alternatives.map(group=>group.join(' & ')).join(' | ');
  return `${left} & (${alt})`;
}

function hostileTruthTable(proof:LearnedProof){
  let cases=0,agreement=0,falseCertainty=0,falseNegatives=0;
  for(const route of ['main','helper'] as const){
    for(const reservation of [false,true]){
      for(const terminated of [false,true]){
        for(const mainAComplete of [false,true]){
          for(const mainASend of [false,true]){
            for(const mainBComplete of [false,true]){
              for(const mainBSend of [false,true]){
                for(const helperComplete of [false,true]){
                  for(const helperSend of [false,true]){
                    const obs:Observation[]=[];
                    if(reservation) obs.push({kind:'reservation'});
                    if(terminated) obs.push({kind:'terminated'});
                    obs.push({kind:'route',value:route});
                    if(mainAComplete) obs.push({kind:'monitor-main-a-complete'});
                    if(mainASend) obs.push({kind:'send-main-a'});
                    if(mainBComplete) obs.push({kind:'monitor-main-b-complete'});
                    if(mainBSend) obs.push({kind:'send-main-b'});
                    if(helperComplete) obs.push({kind:'monitor-helper-complete'});
                    if(helperSend) obs.push({kind:'send-helper'});
                    const expected=proveNoEffect(obs);
                    const actual=evaluateLearned(proof,obs);
                    cases++;
                    if(expected===actual) agreement++;
                    if(actual&&!expected) falseCertainty++;
                    if(!actual&&expected) falseNegatives++;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return {cases,agreement,falseCertainty,falseNegatives};
}

const proof=learnProof();

assert.deepEqual(
  proof.byRoute.main.required,
  ['generation-terminated','reservation-bound','route:main'],
);
assert.deepEqual(
  proof.byRoute.main.alternatives,
  [['main-a-clear'],['main-b-clear']],
);
assert.deepEqual(
  proof.byRoute.helper.required,
  ['generation-terminated','helper-clear','reservation-bound','route:helper'],
);
assert.deepEqual(
  proof.byRoute.helper.alternatives,
  [],
);

const hostile=hostileTruthTable(proof);
assert.equal(hostile.agreement,hostile.cases);
assert.equal(hostile.falseCertainty,0);
assert.equal(hostile.falseNegatives,0);

// Explicitly attack the meaning of absence: a send event invalidates its
// otherwise-complete monitor, and missing completeness never becomes "clear".
const missingCompleteness:Observation[]=[
  {kind:'reservation'},{kind:'terminated'},{kind:'route',value:'main'},
];
assert.equal(evaluateLearned(proof,missingCompleteness),false);

const committedA:Observation[]=[
  {kind:'reservation'},{kind:'terminated'},{kind:'route',value:'main'},
  {kind:'monitor-main-a-complete'},{kind:'send-main-a'},
];
assert.equal(evaluateLearned(proof,committedA),false);

const alternativeClear:Observation[]=[
  {kind:'reservation'},{kind:'terminated'},{kind:'route',value:'main'},
  {kind:'monitor-main-a-complete'},{kind:'send-main-a'},
  {kind:'monitor-main-b-complete'},
];
assert.equal(evaluateLearned(proof,alternativeClear),true);

console.log(`main_formula=${renderClause(proof.byRoute.main)}`);
console.log(`helper_formula=${renderClause(proof.byRoute.helper)}`);
console.log(`main_alternative_count=${proof.byRoute.main.alternatives.length}`);
console.log(`helper_alternative_count=${proof.byRoute.helper.alternatives.length}`);
console.log(`hostile_truth_table_cases=${hostile.cases}`);
console.log(`hostile_truth_table_agreement=${hostile.agreement}`);
console.log(`false_certainty=${hostile.falseCertainty}`);
console.log(`false_negatives=${hostile.falseNegatives}`);
console.log('missing_completeness_fails_closed=true');
console.log('committed_monitor_invalidates_clear=true');
console.log('equivalent_monitor_recovers=true');
