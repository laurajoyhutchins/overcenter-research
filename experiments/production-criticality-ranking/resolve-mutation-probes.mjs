#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url);
const ts=require('typescript');

const propName=(name)=>{
  if(!name) return null;
  if(ts.isIdentifier(name)||ts.isPrivateIdentifier(name)||ts.isStringLiteral(name)||ts.isNumericLiteral(name)) return name.getText();
  return name.getText();
};
const isCallable=(n)=>ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isConstructorDeclaration(n)||ts.isGetAccessorDeclaration(n)||ts.isSetAccessorDeclaration(n)||ts.isArrowFunction(n)||ts.isFunctionExpression(n);
function classNameOf(node){
  let p=node.parent;
  while(p){
    if(ts.isClassDeclaration(p)||ts.isClassExpression(p)) return p.name?.text??'<anonymous-class>';
    p=p.parent;
  }
  return null;
}
function inferredName(node,sf){
  if(ts.isFunctionDeclaration(node)) return node.name?.text??'<anonymous>';
  if(ts.isConstructorDeclaration(node)) return 'constructor';
  if(ts.isMethodDeclaration(node)||ts.isGetAccessorDeclaration(node)||ts.isSetAccessorDeclaration(node)) return propName(node.name)??'<method>';
  if(ts.isArrowFunction(node)||ts.isFunctionExpression(node)){
    const p=node.parent;
    if(ts.isVariableDeclaration(p)&&ts.isIdentifier(p.name)) return p.name.text;
    if(ts.isPropertyAssignment(p)||ts.isPropertyDeclaration(p)||ts.isMethodDeclaration(p)) return propName(p.name)??'<callback>';
  }
  const lc=sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `<callback@${lc.line+1}:${lc.character+1}>`;
}
function callables(root,file){
  const full=path.join(root,file);
  const text=fs.readFileSync(full,'utf8');
  const sf=ts.createSourceFile(full,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const out=[];
  const visit=(node)=>{
    if(isCallable(node)&&node.body){
      const start=sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const end=sf.getLineAndCharacterOfPosition(node.end);
      const name=inferredName(node,sf);
      const owner=classNameOf(node);
      out.push({
        file,
        name,
        qualifiedName:owner?`${owner}.${name}`:name,
        start:start.line+1,
        end:end.line+1,
      });
    }
    ts.forEachChild(node,visit);
  };
  visit(sf);
  return out;
}
export function resolveMutationProbes(root=process.cwd(),config=null){
  const source=config??JSON.parse(fs.readFileSync(path.join(root,'experiments/production-criticality-ranking/mutation-probes.json'),'utf8'));
  const cache=new Map();
  const resolved=[];
  for(const probe of source.probes??[]){
    const ranges=[];
    for(const selector of probe.selectors??[]){
      if(!cache.has(selector.file)) cache.set(selector.file,callables(root,selector.file));
      const matches=cache.get(selector.file).filter(u=>
        selector.qualifiedName ? u.qualifiedName===selector.qualifiedName : u.name===selector.name
      );
      if(matches.length!==1) throw new Error(`mutation probe ${probe.id}: selector ${JSON.stringify(selector)} matched ${matches.length} callables`);
      ranges.push(matches[0]);
    }
    resolved.push({id:probe.id,ranges});
  }
  return {schema:'overcenter-criticality-resolved-mutation-probes/v1',typescript:ts.version,probes:resolved};
}
export function mutatePatterns(resolved){
  return resolved.probes.flatMap(p=>p.ranges.map(r=>`${r.file}:${r.start}-${r.end}`));
}
if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const out=process.argv[2]??'mutation-ranges.json';
  const resolved=resolveMutationProbes(process.cwd());
  fs.writeFileSync(out,JSON.stringify(resolved,null,2)+'\n');
  process.stdout.write(mutatePatterns(resolved).join('\n')+'\n');
}
