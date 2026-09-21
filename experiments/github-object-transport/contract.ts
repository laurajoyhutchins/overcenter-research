#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export function validPath(v){
  if(typeof v!=='string'||!v.length||v.startsWith('/'))return false;
  if([...v].some(ch=>ch.codePointAt(0)<32||ch.codePointAt(0)===127))return false;
  return v.split('/').every(p=>p&&p!=='.'&&p!=='..');
}
export function validateRequest(r){
  if(!r||r.schema!=='github-object-transport/request/v1'||!Array.isArray(r.entries)||!r.entries.length)return false;
  const seen=new Set();
  for(const e of r.entries){if(!e||!validPath(e.path)||typeof e.writable!=='boolean'||seen.has(e.path))return false;seen.add(e.path);}
  return true;
}
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function files(root,here=root){let out=[];for(const e of readdirSync(here,{withFileTypes:true})){const p=join(here,e.name);if(e.isDirectory())out=out.concat(files(root,p));else out.push(relative(root,p).replaceAll('\\','/'));}return out.sort();}
export function verifyManifest(m,root){
  if(!m||m.schema!=='github-object-transport/input/v1'||!Array.isArray(m.entries)||!m.entries.length)throw new Error('INVALID_MANIFEST');
  const expected=m.entries.map(e=>e.path).sort(),actual=files(root);
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('WORKSPACE_MEMBERSHIP_MISMATCH');
  for(const e of m.entries){
    if(!validPath(e.path))throw new Error('INVALID_MANIFEST_PATH');
    const p=join(root,e.path),ls=lstatSync(p);
    if(!ls.isFile()||ls.isSymbolicLink())throw new Error('WORKSPACE_SHAPE_MISMATCH');
    const perm=e.mode==='100755'?0o755:e.mode==='100644'?0o644:null;
    if(perm===null)throw new Error('UNSUPPORTED_MODE');
    if((statSync(p).mode&0o777)!==perm)throw new Error('WORKSPACE_MODE_MISMATCH');
    if(digest(p)!==e.content_sha256)throw new Error('WORKSPACE_CONTENT_MISMATCH');
  }
  return true;
}
const [cmd,...args]=process.argv.slice(2);
if(cmd==='verify-request'){if(!validateRequest(JSON.parse(readFileSync(args[0],'utf8'))))process.exit(1);}
else if(cmd==='verify-manifest')verifyManifest(JSON.parse(readFileSync(args[0],'utf8')),args[1]);
else if(cmd){console.error('usage: contract.ts verify-request <request.json> | verify-manifest <manifest.json> <root>');process.exit(2);}
