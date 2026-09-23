import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function files(root:string):string[]{
  const out:string[]=[];
  for(const name of readdirSync(root)){
    const p=join(root,name);
    if(statSync(p).isDirectory()) out.push(...files(p));
    else if(p.endsWith('.ts')) out.push(p);
  }
  return out;
}

type Site={file:string;line:number;kind:string;detail:string};
const sites:Site[]=[];
const mutating:Site[]=[];
const bypass:Site[]=[];

for(const path of files('src')){
  const text=readFileSync(path,'utf8');
  const rel=relative('.',path).replaceAll('\\','/');
  const lines=text.split('\n');

  lines.forEach((line,index)=>{
    if(/\bfetch\s*\(/.test(line)) sites.push({file:rel,line:index+1,kind:'fetch',detail:line.trim()});
    if(/execFileSync\s*\(/.test(line)) sites.push({file:rel,line:index+1,kind:'exec',detail:line.trim()});
  });

  const mutationPattern=/method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/g;
  for(const match of text.matchAll(mutationPattern)){
    const before=text.slice(0,match.index??0);
    const line=before.split('\n').length;
    const site={file:rel,line,kind:'http-mutation',detail:match[1]};
    mutating.push(site);
    if(!text.includes('kernel.performEffect(')) bypass.push(site);
  }

  const curlMutation=/(?:--request|-X)['"]?\s*[, ]\s*['"]?(POST|PUT|PATCH|DELETE)/g;
  for(const match of text.matchAll(curlMutation)){
    const before=text.slice(0,match.index??0);
    const line=before.split('\n').length;
    const site={file:rel,line,kind:'curl-mutation',detail:match[1]};
    mutating.push(site);
    if(!text.includes('kernel.performEffect(')) bypass.push(site);
  }
}

const performSites:Site[]=[];
for(const path of files('src')){
  const text=readFileSync(path,'utf8');
  const rel=relative('.',path).replaceAll('\\','/');
  text.split('\n').forEach((line,index)=>{
    if(/\bperformEffect\s*(?:<[^>]+>)?\s*\(/.test(line)) {
      performSites.push({file:rel,line:index+1,kind:'performEffect',detail:line.trim()});
    }
  });
}

console.log(`src_ts_files=${files('src').length}`);
console.log(`network_or_process_sites=${sites.length}`);
console.log(`mutation_http_candidates=${mutating.length}`);
for(const x of mutating) console.log(`mutation_candidate=${x.file}:${x.line}:${x.detail}`);
console.log(`perform_effect_sites=${performSites.length}`);
for(const x of performSites) console.log(`perform_effect_site=${x.file}:${x.line}`);
console.log(`mutation_candidates_outside_perform_effect_files=${bypass.length}`);
for(const x of bypass) console.log(`bypass_candidate=${x.file}:${x.line}:${x.detail}`);

assert.ok(mutating.length>0,'AUDIT_NO_MUTATION_CANDIDATES');
assert.equal(bypass.length,0,'MUTATION_CANDIDATE_OUTSIDE_PERFORM_EFFECT_FILE');
