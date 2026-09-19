import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

type X=string|X[];
type Field={name:string;roles:string[]};
type IR={
  verifier:string;
  fields:Field[];
  coordinate_fields:string[];
  output:{selector:'verified-content';field:string};
  absence:{evidence_kind:string;subject_fields:string[];scope_fields:string[]}|null;
  effect:{kind:'none'}|{kind:'same-coordinate';resource_fields:string[];desired_field:string;same_desired_commutes:boolean};
  settlement:'present-only'|'present-or-declared-absence';
  verification:{op:'eq';left_observation:string;right_field:string};
};

const source=readFileSync(new URL('./verifier.lisp',import.meta.url),'utf8');

function parse(src:string):X {
  const tokens=src.replace(/;[^\n]*/g,'').match(/\(|\)|[^\s()]+/g)??[];
  let i=0;
  const one=():X=>{
    const t=tokens[i++];
    if (t===undefined) throw new Error('UNEXPECTED_EOF');
    if (t!=='(') return t;
    const out:X[]=[];
    while (tokens[i]!==')') {
      if (i>=tokens.length) throw new Error('UNCLOSED_LIST');
      out.push(one());
    }
    i++;
    return out;
  };
  const out=one();
  if (i!==tokens.length) throw new Error('TRAILING_TOKENS');
  return out;
}
const list=(x:X,code:string):X[]=>{if(!Array.isArray(x))throw new Error(code);return x;};
const atom=(x:X,code:string):string=>{if(Array.isArray(x))throw new Error(code);return x;};

function compile(src:string):IR {
  const root=list(parse(src),'INVALID_ROOT');
  if(atom(root[0],'INVALID_ROOT')!=='defverifier')throw new Error('EXPECTED_DEFVERIFIER');
  const verifier=atom(root[1],'MISSING_VERIFIER');
  const forms=new Map<string,X[]>();
  for(const raw of root.slice(2)){
    const f=list(raw,'INVALID_FORM');
    const name=atom(f[0],'INVALID_FORM');
    if(forms.has(name))throw new Error('DUPLICATE_FORM:'+name);
    forms.set(name,f.slice(1));
  }
  const allowed=new Set(['fields','observes','absence','effect','settlement','verify']);
  for(const name of forms.keys())if(!allowed.has(name))throw new Error('UNKNOWN_FORM:'+name);
  const need=(name:string):X[]=>{const f=forms.get(name);if(!f)throw new Error('MISSING_FORM:'+name);return f;};

  const validRoles=new Set(['coordinate','desired','output','context']);
  const fields:Field[]=need('fields').map(raw=>{
    const f=list(raw,'INVALID_FIELD');
    if(f.length<3)throw new Error('INVALID_FIELD');
    const name=atom(f[0],'INVALID_FIELD_NAME');
    const roles=f.slice(2).map(x=>atom(x,'INVALID_FIELD_ROLE'));
    for(const role of roles)if(!validRoles.has(role))throw new Error('INVALID_FIELD_ROLE:'+role);
    if(new Set(roles).size!==roles.length)throw new Error('DUPLICATE_FIELD_ROLE:'+name);
    return {name,roles};
  });
  const names=new Set(fields.map(f=>f.name));
  if(names.size!==fields.length)throw new Error('DUPLICATE_FIELD');
  const byRole=(role:string)=>fields.filter(f=>f.roles.includes(role)).map(f=>f.name);
  const coordinates=byRole('coordinate');
  const desired=byRole('desired');
  const outputs=byRole('output');
  if(coordinates.length===0)throw new Error('NO_COORDINATE_FIELDS');
  if(desired.length!==1)throw new Error('EXPECTED_ONE_DESIRED_FIELD');
  if(outputs.length!==1)throw new Error('EXPECTED_ONE_OUTPUT_FIELD');

  const observations=new Set(need('observes').map(raw=>atom(list(raw,'INVALID_OBSERVATION')[0],'INVALID_OBSERVATION')));

  const abs=need('absence');
  if(abs.length!==1)throw new Error('INVALID_ABSENCE');
  const absenceAtom=atom(abs[0],'INVALID_ABSENCE');
  const absence=absenceAtom==='none'?null:{evidence_kind:absenceAtom,subject_fields:[...coordinates],scope_fields:[...coordinates]};

  const ef=need('effect');
  let effect:IR['effect'];
  if(ef.length===1&&atom(ef[0],'INVALID_EFFECT')==='none')effect={kind:'none'};
  else{
    if(ef.length!==3||atom(ef[0],'INVALID_EFFECT')!=='same-coordinate'||atom(ef[1],'INVALID_EFFECT')!=='commutes')throw new Error('INVALID_EFFECT');
    const c=atom(ef[2],'INVALID_EFFECT');
    if(c!=='true'&&c!=='false')throw new Error('INVALID_EFFECT_COMMUTES');
    effect={kind:'same-coordinate',resource_fields:[...coordinates],desired_field:desired[0],same_desired_commutes:c==='true'};
  }

  const set=need('settlement');
  if(set.length!==1)throw new Error('INVALID_SETTLEMENT');
  const settlement=atom(set[0],'INVALID_SETTLEMENT');
  if(settlement!=='present-only'&&settlement!=='present-or-declared-absence')throw new Error('INVALID_SETTLEMENT_POLICY:'+settlement);
  if(settlement==='present-only'&&absence)throw new Error('DECLARED_ABSENCE_UNUSED_BY_SETTLEMENT');
  if(settlement==='present-or-declared-absence'&&!absence)throw new Error('SETTLEMENT_REQUIRES_DECLARED_ABSENCE');

  const v=need('verify');
  if(v.length!==3||atom(v[0],'INVALID_VERIFY')!=='eq'||atom(v[2],'INVALID_VERIFY')!=='desired')throw new Error('INVALID_VERIFY');
  const left=atom(v[1],'INVALID_VERIFY');
  if(!observations.has(left))throw new Error('UNKNOWN_VERIFY_OBSERVATION:'+left);

  return {
    verifier,fields,coordinate_fields:coordinates,
    output:{selector:'verified-content',field:outputs[0]},
    absence,effect,
    settlement,
    verification:{op:'eq',left_observation:left,right_field:desired[0]},
  };
}

const project=(ir:IR,input:Record<string,unknown>)=>({
  coordinate:Object.fromEntries(ir.coordinate_fields.map(k=>[k,input[k]])),
  effect:ir.effect.kind==='same-coordinate'?{
    resource:Object.fromEntries(ir.effect.resource_fields.map(k=>[k,input[k]])),
    desired:input[ir.effect.desired_field],
  }:null,
  output:input[ir.output.field],
  absence:ir.absence?{
    subject:Object.fromEntries(ir.absence.subject_fields.map(k=>[k,input[k]])),
    scope:Object.fromEntries(ir.absence.scope_fields.map(k=>[k,input[k]])),
  }:null,
});
const emit=(ir:IR)=>JSON.stringify(ir,null,2)+'\n';
const expectError=(src:string,message:string)=>assert.throws(()=>compile(src),(e:unknown)=>e instanceof Error&&e.message===message);

// Null hypothesis: obligation identity is already safe because real Overcenter hashes the
// complete postcondition. These hand-wired projections model the remaining fan-out.
type Baseline={artifact:string;source_revision:string;expected_sha256:string};
const baselineObservationCoordinate=(x:Baseline)=>({artifact:x.artifact,source_revision:x.source_revision});
const baselineEffectResource=(x:Baseline)=>({artifact:x.artifact,source_revision:x.source_revision});
const baselineOutputIdentity=(x:Baseline)=>x.expected_sha256;
const baselineAbsenceScope=(x:Baseline)=>({artifact:x.artifact,source_revision:x.source_revision});
const baselineWholePostcondition=(x:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))));

test('control: whole-postcondition identity changes, but independent coordinate projections can still forget a new authority field',()=>{
  type Evolved=Baseline&{authority:string};
  const a:Evolved={authority:'cluster-a',artifact:'dist/app.tar',source_revision:'abc123',expected_sha256:'deadbeef'};
  const b:Evolved={...a,authority:'cluster-b'};
  assert.notEqual(baselineWholePostcondition(a),baselineWholePostcondition(b));
  assert.deepEqual(baselineObservationCoordinate(a),baselineObservationCoordinate(b));
  assert.deepEqual(baselineEffectResource(a),baselineEffectResource(b));
  assert.deepEqual(baselineAbsenceScope(a),baselineAbsenceScope(b));
  assert.equal(baselineOutputIdentity(a),baselineOutputIdentity(b));
});

test('candidate: declaring a new coordinate field once updates observation, effect, and absence projections together',()=>{
  const evolved=source.replace('(artifact string coordinate)','(authority string coordinate)\n    (artifact string coordinate)');
  const ir=compile(evolved);
  const a={authority:'cluster-a',artifact:'dist/app.tar','source-revision':'abc123','expected-sha256':'deadbeef'};
  const b={...a,authority:'cluster-b'};
  const pa=project(ir,a);
  const pb=project(ir,b);
  assert.notDeepEqual(pa.coordinate,pb.coordinate);
  assert.notDeepEqual(pa.effect?.resource,pb.effect?.resource);
  assert.notDeepEqual(pa.absence?.subject,pb.absence?.subject);
  assert.notDeepEqual(pa.absence?.scope,pb.absence?.scope);
  assert.equal(pa.output,pb.output);
});

test('candidate: context-only fields do not contaminate coordinate, effect, absence, or output identity',()=>{
  const evolved=source.replace('(artifact string coordinate)','(display-label string context)\n    (artifact string coordinate)');
  const ir=compile(evolved);
  const base={artifact:'dist/app.tar','source-revision':'abc123','expected-sha256':'deadbeef'};
  assert.deepEqual(project(ir,{...base,'display-label':'a'}),project(ir,{...base,'display-label':'b'}));
});

test('candidate rejects missing or ambiguous semantic roles',()=>{
  expectError(source.replace(' desired output',' output'),'EXPECTED_ONE_DESIRED_FIELD');
  expectError(source.replace(' desired output',' desired'),'EXPECTED_ONE_OUTPUT_FIELD');
});

test('candidate rejects missing settlement semantics and absence-policy drift',()=>{
  expectError(source.replace(/\n  \(settlement present-or-declared-absence\)\n/,'\n'),'MISSING_FORM:settlement');
  expectError(source.replace('(settlement present-or-declared-absence)','(settlement present-only)'),'DECLARED_ABSENCE_UNUSED_BY_SETTLEMENT');
});

test('candidate rejects undeclared forms instead of creating ad hoc semantic escape hatches',()=>{
  expectError(source.replace('(absence artifact-enoent-at-coordinate/v1)','(absence artifact-enoent-at-coordinate/v1)\n  (effect-resource artifact)'),'UNKNOWN_FORM:effect-resource');
});

test('candidate generation is deterministic and tampering is distinguishable',()=>{
  const a=emit(compile(source));
  const b=emit(compile(source));
  assert.equal(a,b);
  assert.notEqual(a.replace('artifact-enoent-at-coordinate/v1','artifact-enoent-at-coordinate/v2'),a);
});
