import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

type X=string|X[];
type IR={
  verifier:string;
  fields:Array<{name:string;material:boolean}>;
  identity:string[];
  output:{selector:string;source:string};
  absence:string|null;
  effect:{kind:'none'}|{kind:'resource';resource:string;desired:string;commutes:boolean};
  settlement:'present-only'|'present-or-declared-absence';
  verify:{left:string;right:string};
};

const source=readFileSync(new URL('./verifier.lisp',import.meta.url),'utf8');

function parse(src:string):X {
  const tokens=src.replace(/;[^\n]*/g,'').match(/\(|\)|[^\s()]+/g)??[];
  let i=0;
  const one=():X=>{
    const t=tokens[i++];
    if (t===undefined) throw new Error('UNEXPECTED_EOF');
    if (t!== '(') return t;
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

const list=(x:X,code:string):X[]=>{
  if (!Array.isArray(x)) throw new Error(code);
  return x;
};
const atom=(x:X,code:string):string=>{
  if (Array.isArray(x)) throw new Error(code);
  return x;
};

function compile(src:string):IR {
  const root=list(parse(src),'INVALID_ROOT');
  if (atom(root[0],'INVALID_ROOT')!=='defverifier') throw new Error('EXPECTED_DEFVERIFIER');
  const verifier=atom(root[1],'MISSING_VERIFIER');
  const forms=new Map<string,X[]>();
  for (const raw of root.slice(2)) {
    const f=list(raw,'INVALID_FORM');
    const name=atom(f[0],'INVALID_FORM');
    if (forms.has(name)) throw new Error('DUPLICATE_FORM:'+name);
    forms.set(name,f.slice(1));
  }
  const allowed=new Set(['fields','observes','identity','output','absence','effect','settlement','verify']);
  for (const name of forms.keys()) if (!allowed.has(name)) throw new Error('UNKNOWN_FORM:'+name);
  const need=(name:string):X[]=>{
    const f=forms.get(name);
    if (!f) throw new Error('MISSING_FORM:'+name);
    return f;
  };

  const fields=need('fields').map(raw=>{
    const f=list(raw,'INVALID_FIELD');
    if (f.length!==3) throw new Error('INVALID_FIELD');
    const role=atom(f[2],'INVALID_FIELD_ROLE');
    if (role!=='material' && role!=='context') throw new Error('INVALID_FIELD_ROLE:'+role);
    return {name:atom(f[0],'INVALID_FIELD_NAME'),material:role==='material'};
  });
  const names=new Set(fields.map(f=>f.name));
  if (names.size!==fields.length) throw new Error('DUPLICATE_FIELD');

  const observations=new Set(need('observes').map(raw=>atom(list(raw,'INVALID_OBSERVATION')[0],'INVALID_OBSERVATION')));
  const identity=need('identity').map(x=>atom(x,'INVALID_IDENTITY'));
  const ids=new Set(identity);
  if (!ids.has('verifier-version')) throw new Error('VERIFIER_VERSION_NOT_IN_IDENTITY');
  for (const id of identity) if (id!=='verifier-version' && !names.has(id)) throw new Error('UNKNOWN_IDENTITY_COMPONENT:'+id);
  for (const f of fields) if (f.material && !ids.has(f.name)) throw new Error('MATERIAL_FIELD_NOT_IN_IDENTITY:'+f.name);

  const out=need('output');
  if (out.length!==2) throw new Error('INVALID_OUTPUT');
  const output={selector:atom(out[0],'INVALID_OUTPUT'),source:atom(out[1],'INVALID_OUTPUT')};
  if (!names.has(output.source)) throw new Error('UNKNOWN_OUTPUT_SOURCE:'+output.source);
  if (!ids.has(output.source)) throw new Error('OUTPUT_SOURCE_NOT_IN_IDENTITY:'+output.source);

  const abs=need('absence');
  if (abs.length!==1) throw new Error('INVALID_ABSENCE');
  const a=atom(abs[0],'INVALID_ABSENCE');
  const absence=a==='none'?null:a;

  const ef=need('effect');
  let effect:IR['effect'];
  if (ef.length===1 && atom(ef[0],'INVALID_EFFECT')==='none') effect={kind:'none'};
  else {
    if (ef.length!==6 || atom(ef[0],'INVALID_EFFECT')!=='resource' || atom(ef[2],'INVALID_EFFECT')!=='desired' || atom(ef[4],'INVALID_EFFECT')!=='commutes') throw new Error('INVALID_EFFECT');
    const resource=atom(ef[1],'INVALID_EFFECT');
    const desired=atom(ef[3],'INVALID_EFFECT');
    if (!names.has(resource)) throw new Error('UNKNOWN_EFFECT_RESOURCE_FIELD:'+resource);
    if (!names.has(desired)) throw new Error('UNKNOWN_EFFECT_DESIRED_FIELD:'+desired);
    if (!ids.has(resource)) throw new Error('EFFECT_RESOURCE_NOT_IN_IDENTITY:'+resource);
    if (!ids.has(desired)) throw new Error('EFFECT_DESIRED_NOT_IN_IDENTITY:'+desired);
    const c=atom(ef[5],'INVALID_EFFECT');
    if (c!=='true' && c!=='false') throw new Error('INVALID_EFFECT_COMMUTES');
    effect={kind:'resource',resource,desired,commutes:c==='true'};
  }

  const set=need('settlement');
  if (set.length!==1) throw new Error('INVALID_SETTLEMENT');
  const settlement=atom(set[0],'INVALID_SETTLEMENT');
  if (settlement!=='present-only' && settlement!=='present-or-declared-absence') throw new Error('INVALID_SETTLEMENT_POLICY:'+settlement);
  if (settlement==='present-only' && absence) throw new Error('DECLARED_ABSENCE_UNUSED_BY_SETTLEMENT');
  if (settlement==='present-or-declared-absence' && !absence) throw new Error('SETTLEMENT_REQUIRES_DECLARED_ABSENCE');

  const v=need('verify');
  if (v.length!==3 || atom(v[0],'INVALID_VERIFY')!=='eq') throw new Error('INVALID_VERIFY');
  const left=atom(v[1],'INVALID_VERIFY');
  const right=atom(v[2],'INVALID_VERIFY');
  if (!observations.has(left)) throw new Error('UNKNOWN_VERIFY_OBSERVATION:'+left);
  if (!names.has(right)) throw new Error('UNKNOWN_VERIFY_FIELD:'+right);
  if (!ids.has(right)) throw new Error('VERIFY_FIELD_NOT_IN_IDENTITY:'+right);

  return {verifier,fields,identity,output,absence,effect,settlement,verify:{left,right}};
}

const emit=(ir:IR):string=>JSON.stringify(ir,null,2)+'\n';
const identity=(ir:IR,input:Record<string,unknown>):Record<string,unknown>=>Object.fromEntries(
  ir.identity.map(k=>[k,k==='verifier-version'?ir.verifier:input[k]]),
);
const producedAbsence=(ir:IR)=>ir.absence;
const acceptedAbsence=(ir:IR)=>ir.settlement==='present-or-declared-absence'&&ir.absence?[ir.absence]:[];
const expectError=(src:string,message:string)=>assert.throws(()=>compile(src),(e:unknown)=>e instanceof Error&&e.message===message);

// Null hypothesis: the current TypeScript shape keeps these semantics in independent code sites.
type Baseline={verifier:'artifact-content-at-revision/v1';artifact:string;source_revision:string;expected_sha256:string};
const baselineValid=(x:unknown):x is Baseline=>{
  if (!x||typeof x!=='object') return false;
  const v=x as Record<string,unknown>;
  return v.verifier==='artifact-content-at-revision/v1'&&typeof v.artifact==='string'&&typeof v.source_revision==='string'&&typeof v.expected_sha256==='string';
};
const baselineIdentity=(x:Baseline)=>({verifier:x.verifier,artifact:x.artifact,source_revision:x.source_revision,expected_sha256:x.expected_sha256});
const baselineOutput=(x:Baseline)=>x.expected_sha256;
const baselineAbsence=()=>['artifact-enoent-at-revision/v1'];
const baselineEffect=()=>null;
const baselineVerify=(x:Baseline,o:{observed_sha256?:string})=>o.observed_sha256===x.expected_sha256;
void baselineOutput; void baselineAbsence; void baselineEffect; void baselineVerify;

test('control: an added material field does not force the hand-wired TypeScript identity to change',()=>{
  type Evolved=Baseline&{compression:'none'|'gzip'};
  const a:Evolved={verifier:'artifact-content-at-revision/v1',artifact:'dist/app.tar',source_revision:'abc123',expected_sha256:'deadbeef',compression:'none'};
  const b:Evolved={...a,compression:'gzip'};
  assert.equal(baselineValid(a),true);
  assert.equal(baselineValid(b),true);
  assert.deepEqual(baselineIdentity(a),baselineIdentity(b));
});

test('candidate: a new material field is rejected until identity accounts for it',()=>{
  const bad=source.replace('(expected-sha256 digest material))','(expected-sha256 digest material)\n    (compression symbol material))');
  expectError(bad,'MATERIAL_FIELD_NOT_IN_IDENTITY:compression');
  const good=bad.replace('    expected-sha256)\n\n  (output','    expected-sha256\n    compression)\n\n  (output');
  const ir=compile(good);
  const base={artifact:'dist/app.tar','source-revision':'abc123','expected-sha256':'deadbeef'};
  assert.notDeepEqual(identity(ir,{...base,compression:'none'}),identity(ir,{...base,compression:'gzip'}));
});

test('candidate: context-only fields are deliberately allowed outside identity',()=>{
  const evolved=source.replace('(expected-sha256 digest material))','(expected-sha256 digest material)\n    (display-label string context))');
  const ir=compile(evolved);
  const base={artifact:'dist/app.tar','source-revision':'abc123','expected-sha256':'deadbeef'};
  assert.deepEqual(identity(ir,{...base,'display-label':'a'}),identity(ir,{...base,'display-label':'b'}));
});

test('candidate rejects missing settlement semantics',()=>{
  expectError(source.replace(/\n  \(settlement present-or-declared-absence\)\n/,'\n'),'MISSING_FORM:settlement');
});

test('candidate requires verifier version in identity',()=>{
  expectError(source.replace('    verifier-version\n',''),'VERIFIER_VERSION_NOT_IN_IDENTITY');
});

test('candidate rejects output outside the declared vocabulary',()=>{
  expectError(source.replace('(output verified-content expected-sha256)','(output verified-content phantom-digest)'),'UNKNOWN_OUTPUT_SOURCE:phantom-digest');
});

test('candidate rejects effect coordinates outside the declared vocabulary',()=>{
  expectError(source.replace('(effect none)','(effect resource phantom desired expected-sha256 commutes true)'),'UNKNOWN_EFFECT_RESOURCE_FIELD:phantom');
});

test('candidate derives absence production and settlement acceptance from one declaration',()=>{
  const ir=compile(source);
  assert.equal(producedAbsence(ir),'artifact-enoent-at-revision/v1');
  assert.deepEqual(acceptedAbsence(ir),['artifact-enoent-at-revision/v1']);
  expectError(source.replace('(settlement present-or-declared-absence)','(settlement present-only)'),'DECLARED_ABSENCE_UNUSED_BY_SETTLEMENT');
});

test('candidate generation is deterministic and tampering is distinguishable',()=>{
  const a=emit(compile(source));
  const b=emit(compile(source));
  assert.equal(a,b);
  assert.notEqual(a.replace('artifact-enoent-at-revision/v1','artifact-enoent-at-revision/v2'),a);
});
