#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url);
const ts=require('typescript');

function walk(root, predicate){
  const out=[];
  if(!fs.existsSync(root)) return out;
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    const p=path.join(root,entry.name);
    if(entry.isDirectory()) out.push(...walk(p,predicate));
    else if(predicate(p)) out.push(p);
  }
  return out;
}
const rel=(root,p)=>path.relative(root,p).split(path.sep).join('/');
const hasModifier=(node,kind)=>Boolean(node.modifiers?.some(m=>m.kind===kind));
const propName=(name)=>{
  if(!name) return null;
  if(ts.isIdentifier(name)||ts.isPrivateIdentifier(name)||ts.isStringLiteral(name)||ts.isNumericLiteral(name)) return name.text;
  return name.getText();
};
function classNameOf(node){
  let p=node.parent;
  while(p){
    if(ts.isClassDeclaration(p)||ts.isClassExpression(p)) return p.name?.text ?? '<anonymous-class>';
    p=p.parent;
  }
  return null;
}
function inferredName(node,source){
  if(ts.isFunctionDeclaration(node)) return node.name?.text ?? `<anonymous@${source.getLineAndCharacterOfPosition(node.getStart()).line+1}>`;
  if(ts.isMethodDeclaration(node)||ts.isGetAccessorDeclaration(node)||ts.isSetAccessorDeclaration(node)) return propName(node.name) ?? '<method>';
  if(ts.isConstructorDeclaration(node)) return 'constructor';
  if(ts.isArrowFunction(node)||ts.isFunctionExpression(node)){
    const p=node.parent;
    if(ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if(ts.isPropertyAssignment(p)||ts.isPropertyDeclaration(p)||ts.isMethodDeclaration(p)) return propName(p.name) ?? '<callback>';
    const lc=source.getLineAndCharacterOfPosition(node.getStart());
    return `<callback@${lc.line+1}:${lc.character+1}>`;
  }
  return '<callable>';
}
const isCallable=(n)=>ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isConstructorDeclaration(n)||ts.isGetAccessorDeclaration(n)||ts.isSetAccessorDeclaration(n)||ts.isArrowFunction(n)||ts.isFunctionExpression(n);
function exportedContext(node){
  if(hasModifier(node,ts.SyntaxKind.ExportKeyword)) return true;
  let p=node.parent;
  while(p){
    if(ts.isClassDeclaration(p)) return hasModifier(p,ts.SyntaxKind.ExportKeyword) && !hasModifier(node,ts.SyntaxKind.PrivateKeyword);
    if(isCallable(p)) break;
    p=p.parent;
  }
  if((ts.isArrowFunction(node)||ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)){
    const st=node.parent.parent?.parent;
    if(st && ts.isVariableStatement(st)) return hasModifier(st,ts.SyntaxKind.ExportKeyword);
  }
  return false;
}
function unitForNode(node,nodeToUnit){
  let p=node;
  while(p){
    if(nodeToUnit.has(p)) return nodeToUnit.get(p);
    p=p.parent;
  }
  return null;
}
function externalCallBoundary(expression,checker,projectFiles){
  const project=new Set(projectFiles);
  const seen=new Set();
  const visit=node=>{
    if(!node || seen.has(node)) return null;
    seen.add(node);
    const symbol=checker.getSymbolAtLocation(node);
    for(const declaration of symbol?.declarations??[]){
      const source=declaration.getSourceFile()?.fileName;
      if(source && !project.has(source)) return source;
      let p=declaration;
      while(p){
        if(ts.isImportDeclaration(p) && ts.isStringLiteral(p.moduleSpecifier)){
          const specifier=p.moduleSpecifier.text;
          if(!specifier.startsWith('.') && !path.isAbsolute(specifier)) return specifier;
          break;
        }
        p=p.parent;
      }
    }
    if(ts.isPropertyAccessExpression(node)) return visit(node.expression)??visit(node.name);
    if(ts.isElementAccessExpression(node)) return visit(node.expression)??visit(node.argumentExpression);
    if(ts.isCallExpression(node)||ts.isNewExpression(node)) return visit(node.expression);
    return null;
  };
  return visit(expression);
}
function bindingContainsIdentifier(name,target){
  if(ts.isIdentifier(name)) return name.text===target;
  if(ts.isObjectBindingPattern(name)||ts.isArrayBindingPattern(name)){
    return name.elements.some(element=>ts.isBindingElement(element) && bindingContainsIdentifier(element.name,target));
  }
  return false;
}
function parameterBoundCall(expression){
  if(!ts.isIdentifier(expression)) return false;
  const target=expression.text;
  let p=expression.parent;
  while(p){
    if(isCallable(p)){
      return p.parameters.some(parameter=>bindingContainsIdentifier(parameter.name,target));
    }
    p=p.parent;
  }
  return false;
}
function concreteDispatchTargets(declaration,units,checker){
  if(!ts.isMethodSignature(declaration) || !ts.isInterfaceDeclaration(declaration.parent)) return [];
  const methodName=propName(declaration.name);
  const contractType=checker.getTypeAtLocation(declaration.parent);
  return units.filter(unit=>{
    if(!ts.isMethodDeclaration(unit.node) || propName(unit.node.name)!==methodName) return false;
    const owner=unit.node.parent;
    if(!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) return false;
    return checker.isTypeAssignableTo(checker.getTypeAtLocation(owner),contractType);
  });
}
function graphReach(start,adj){
  const seen=new Set([start]);
  const stack=[start];
  while(stack.length){
    const u=stack.pop();
    for(const v of adj.get(u)??[]){
      if(!seen.has(v)){seen.add(v);stack.push(v);}
    }
  }
  return seen;
}
function immediatePredecessors(nodes,edges){
  const pred=new Map([...nodes].map(n=>[n,new Set()]));
  for(const [u,vs] of edges){
    if(!nodes.has(u)) continue;
    for(const v of vs) if(nodes.has(v)) pred.get(v).add(u);
  }
  return pred;
}
function dominators(start,edges){
  const reachable=graphReach(start,edges);
  const pred=immediatePredecessors(reachable,edges);
  const dom=new Map();
  for(const n of reachable) dom.set(n,n===start?new Set([start]):new Set(reachable));
  let changed=true;
  while(changed){
    changed=false;
    for(const n of reachable){
      if(n===start) continue;
      const ps=[...(pred.get(n)??[])];
      let next;
      if(ps.length===0) next=new Set([n]);
      else {
        next=new Set(dom.get(ps[0]));
        for(const p of ps.slice(1)) for(const x of [...next]) if(!dom.get(p).has(x)) next.delete(x);
        next.add(n);
      }
      const prior=dom.get(n);
      if(prior.size!==next.size || [...prior].some(x=>!next.has(x))){dom.set(n,next);changed=true;}
    }
  }
  return {reachable,dom};
}
function git(root,args,opts={}){
  return execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],...opts}).trim();
}
function blameTimes(root,file){
  const text=git(root,['blame','--line-porcelain','--',file]);
  const times=new Map();
  let lineNo=null;
  for(const line of text.split('\n')){
    const h=line.match(/^[0-9a-f^]{40}\s+\d+\s+(\d+)(?:\s+\d+)?$/);
    if(h){lineNo=Number(h[1]);continue;}
    const t=line.match(/^author-time\s+(\d+)$/);
    if(t && lineNo!==null) times.set(lineNo,Number(t[1]));
  }
  return times;
}
function selectOne(units,selector,label){
  const matches=units.filter(u=>u.file===selector.file && (selector.qualifiedName?u.qualifiedName===selector.qualifiedName:u.name===selector.name));
  if(matches.length!==1) throw new Error(`${label}: selector ${JSON.stringify(selector)} matched ${matches.length} units`);
  return matches[0];
}
function normalizeLog(value,max){
  if(max<=0||value<=0) return 0;
  return Math.log1p(value)/Math.log1p(max);
}
function round(n,d=4){const p=10**d;return Math.round(n*p)/p;}

export function analyze({root,config}){
  const productionFiles=walk(path.join(root,'src'),p=>p.endsWith('.ts')&&!p.endsWith('.d.ts'));
  const supportFiles=[...walk(path.join(root,'test'),p=>p.endsWith('.ts')),...walk(path.join(root,'experiments'),p=>p.endsWith('.ts'))];
  const files=[...new Set([...productionFiles,...supportFiles])];
  const program=ts.createProgram(files,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,allowImportingTsExtensions:true,noEmit:true,skipLibCheck:true});
  const checker=program.getTypeChecker();
  const units=[];
  const nodeToUnit=new Map();
  const classExport=new Map();

  for(const sf of program.getSourceFiles()){
    const file=rel(root,sf.fileName);
    if(!files.includes(sf.fileName)) continue;
    const visit=(node)=>{
      if(ts.isClassDeclaration(node)||ts.isClassExpression(node)) classExport.set(node,hasModifier(node,ts.SyntaxKind.ExportKeyword));
      if(isCallable(node) && node.body){
        const start=sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const end=sf.getLineAndCharacterOfPosition(node.end);
        const name=inferredName(node,sf);
        const owner=classNameOf(node);
        const qualifiedName=owner?`${owner}.${name}`:name;
        const scope=file.startsWith('src/')?'production':file.startsWith('test/')?'test':file.startsWith('experiments/')?'experiment':'other';
        const unit={id:`${file}::${qualifiedName}@${start.line+1}:${start.character+1}`,file,name,qualifiedName,startLine:start.line+1,endLine:end.line+1,scope,exported:exportedContext(node),node};
        units.push(unit);nodeToUnit.set(node,unit);
      }
      ts.forEachChild(node,visit);
    };
    visit(sf);
  }

  const edges=new Map(units.map(u=>[u.id,new Set()]));
  const unresolvedCallsites=[];
  const scopes=['production','test','experiment','other'];
  const callStats=Object.fromEntries(scopes.map(scope=>[scope,{resolvedInternalCalls:0,resolvedPolymorphicCalls:0,unresolvedInternalCalls:0,externalCalls:0,externalCallbackCalls:0,unknownCalls:0}]));
  let resolvedInternalCalls=0,unresolvedInternalCalls=0,externalCalls=0,unknownCalls=0;
  const bump=(caller,key)=>{ callStats[caller.scope][key]+=1; };
  for(const sf of program.getSourceFiles()){
    if(!files.includes(sf.fileName)) continue;
    const visit=(node)=>{
      if(ts.isCallExpression(node)||ts.isNewExpression(node)){
        const caller=unitForNode(node.parent,nodeToUnit);
        if(caller){
          const externalCallback=parameterBoundCall(node.expression);
          const sig=externalCallback?null:checker.getResolvedSignature(node);
          let decl=sig?.declaration??null;
          let callee=decl?unitForNode(decl,nodeToUnit):null;
          if(!callee && decl && ts.isVariableDeclaration(decl) && decl.initializer && isCallable(decl.initializer)) callee=nodeToUnit.get(decl.initializer)??null;
          const polymorphicTargets=!callee && decl ? concreteDispatchTargets(decl,units,checker) : [];
          if(externalCallback){
            externalCalls++;
            bump(caller,'externalCalls');
            bump(caller,'externalCallbackCalls');
          } else if(callee){
            edges.get(caller.id).add(callee.id);
            resolvedInternalCalls++;
            bump(caller,'resolvedInternalCalls');
          } else if(polymorphicTargets.length){
            for(const target of polymorphicTargets) edges.get(caller.id).add(target.id);
            resolvedInternalCalls++;
            bump(caller,'resolvedInternalCalls');
            bump(caller,'resolvedPolymorphicCalls');
          } else if(decl){
            const declarationFile=decl.getSourceFile()?.fileName;
            if(declarationFile && files.includes(declarationFile)){
              unresolvedInternalCalls++;
              bump(caller,'unresolvedInternalCalls');
              const lc=sf.getLineAndCharacterOfPosition(node.getStart(sf));
              unresolvedCallsites.push({
                kind:'internal',
                caller:caller.id,
                file:rel(root,sf.fileName),
                line:lc.line+1,
                expression:node.expression?.getText(sf)??node.getText(sf).slice(0,120),
                declaration_file:rel(root,declarationFile),
              });
            } else {
              externalCalls++;
              bump(caller,'externalCalls');
            }
          } else {
            const externalBoundary=externalCallBoundary(node.expression,checker,files);
            if(externalBoundary){
              externalCalls++;
              bump(caller,'externalCalls');
            } else {
              unknownCalls++;
              bump(caller,'unknownCalls');
              const lc=sf.getLineAndCharacterOfPosition(node.getStart(sf));
              unresolvedCallsites.push({
                kind:'unknown',
                caller:caller.id,
                file:rel(root,sf.fileName),
                line:lc.line+1,
                expression:node.expression?.getText(sf)??node.getText(sf).slice(0,120),
                declaration_file:null,
              });
            }
          }
        }
      }
      ts.forEachChild(node,visit);
    };
    visit(sf);
  }

  const byId=new Map(units.map(u=>[u.id,u]));
  const production=units.filter(u=>u.scope==='production');
  const prodIds=new Set(production.map(u=>u.id));
  const prodEdges=new Map(production.map(u=>[u.id,new Set([...(edges.get(u.id)??[])].filter(v=>prodIds.has(v)))]));
  const reverse=new Map(production.map(u=>[u.id,new Set()]));
  for(const [u,vs] of prodEdges) for(const v of vs) reverse.get(v).add(u);

  const mutationEvidenceByUnit=new Map();
  const mutationEvidenceStatus={applied:[],stale:[],missing:[]};
  if(config.mutationEvidenceFile){
    const evidencePath=path.join(root,config.mutationEvidenceFile);
    const snapshot=JSON.parse(fs.readFileSync(evidencePath,'utf8'));
    if(snapshot.schema!=='overcenter-criticality-mutation-evidence/v1') throw new Error(`unsupported mutation evidence schema: ${snapshot.schema}`);
    const sourceRun=snapshot.source_run;
    if(!sourceRun
      || !/^[0-9a-f]{40}$/.test(sourceRun.revision??'')
      || !Number.isInteger(sourceRun.workflow_run_id)
      || sourceRun.workflow_run_id<=0
      || !/^sha256:[0-9a-f]{64}$/.test(sourceRun.mutation_report_sha256??'')){
      throw new Error('mutation evidence is missing trusted-run provenance fields');
    }
    for(const probe of snapshot.probes??[]){
      const selected=(probe.selectors??[]).map(selector=>selectOne(production,selector,`mutation-evidence:${probe.id}`));
      const staleFiles=[];
      for(const [file,expected] of Object.entries(probe.source_blobs??{})){
        const actual=git(root,['hash-object',file]);
        if(actual!==expected) staleFiles.push({file,expected,actual});
      }
      const score=staleFiles.length?0:Number(probe.mutation_score);
      if(!Number.isFinite(score)||score<0||score>1) throw new Error(`invalid mutation score for ${probe.id}: ${probe.mutation_score}`);
      const status=staleFiles.length?'stale':'applied';
      mutationEvidenceStatus[status].push({id:probe.id,mutationScore:score,staleFiles});
      for(const unit of selected){
        const prior=mutationEvidenceByUnit.get(unit.id);
        if(!prior || score<prior.mutationScore){
          mutationEvidenceByUnit.set(unit.id,{probeId:probe.id,mutationScore:score,status,sourceRun:snapshot.source_run??null});
        }
      }
    }
  }

  const authority=config.authorityClasses.map(a=>({...a,unit:selectOne(production,a.sink,`authority:${a.id}`)}));
  const recovery=config.recoveryScenarios.map(s=>({...s,entryUnit:selectOne(production,s.entry,`recovery:${s.id}:entry`),terminalUnit:selectOne(production,s.terminal,`recovery:${s.id}:terminal`)}));
  const resolveCalibration=(pairs,kind)=>(pairs??[]).map(c=>({
    ...c,
    kind,
    higherUnit:selectOne(production,c.higher,`calibration:${c.id}:higher`),
    lowerUnit:selectOne(production,c.lower,`calibration:${c.id}:lower`),
  }));
  const requiredCalibration=resolveCalibration(config.requiredCalibrationPairs,'required');
  const diagnosticCalibration=resolveCalibration(config.diagnosticCalibrationPairs,'diagnostic');
  const allCalibration=[...requiredCalibration,...diagnosticCalibration];

  const resolutionByScope=Object.fromEntries(Object.entries(callStats).map(([scope,stats])=>{
    const denominator=stats.resolvedInternalCalls+stats.unresolvedInternalCalls+stats.unknownCalls;
    return [scope,{...stats,internalResolutionRate:denominator?stats.resolvedInternalCalls/denominator:1}];
  }));
  const scopeByUnitId=new Map(units.map(unit=>[unit.id,unit.scope]));
  for(const [scope,minimum] of Object.entries(config.graphQuality?.minimumResolution??{})){
    const actual=resolutionByScope[scope]?.internalResolutionRate;
    if(actual===undefined) throw new Error(`graph quality names unknown scope ${scope}`);
    if(actual<minimum){
      const examples=unresolvedCallsites
        .filter(callsite=>scopeByUnitId.get(callsite.caller)===scope)
        .slice(0,8)
        .map(callsite=>`${callsite.caller} -> ${callsite.expression} at ${callsite.file}:${callsite.line}`);
      throw new Error(`graph resolution for ${scope} fell below floor: ${actual.toFixed(4)} < ${Number(minimum).toFixed(4)}${examples.length?`; unresolved examples: ${examples.join('; ')}`:''}`);
    }
  }
  const criticalUnits=new Set([
    ...authority.map(a=>a.unit.id),
    ...recovery.flatMap(s=>[s.entryUnit.id,s.terminalUnit.id]),
    ...allCalibration.flatMap(c=>[c.higherUnit.id,c.lowerUnit.id]),
  ]);
  const criticalUnresolved=unresolvedCallsites.filter(c=>criticalUnits.has(c.caller));
  if((config.graphQuality?.failOnCriticalUnresolved??true) && criticalUnresolved.length){
    const first=criticalUnresolved[0];
    throw new Error(`critical callable has unresolved callsite: ${first.caller} -> ${first.expression} at ${first.file}:${first.line}`);
  }
  const requiredMutationUnits=new Set([
    ...authority.map(a=>a.unit.id),
    ...recovery.map(s=>s.terminalUnit.id),
    ...allCalibration.flatMap(c=>[c.higherUnit.id,c.lowerUnit.id]),
  ]);

  const scenarioDominators=new Map();
  for(const s of recovery){
    const d=dominators(s.entryUnit.id,prodEdges);
    if(!d.reachable.has(s.terminalUnit.id)) throw new Error(`recovery scenario ${s.id} has no static call path from ${s.entryUnit.qualifiedName} to ${s.terminalUnit.qualifiedName}`);
    scenarioDominators.set(s.id,d.dom.get(s.terminalUnit.id));
  }

  const prodEntrypoints=production.filter(u=>u.exported);
  const testEntrypoints=units.filter(u=>u.scope==='test');
  const experimentEntrypoints=units.filter(u=>u.scope==='experiment');
  const allReachCache=new Map();
  const allReach=(id)=>{if(!allReachCache.has(id)) allReachCache.set(id,graphReach(id,edges));return allReachCache.get(id);};
  const prodReachCache=new Map();
  const prodReach=(id)=>{if(!prodReachCache.has(id)) prodReachCache.set(id,graphReach(id,prodEdges));return prodReachCache.get(id);};
  const reverseReachCache=new Map();
  const reverseReach=(id)=>{if(!reverseReachCache.has(id)) reverseReachCache.set(id,graphReach(id,reverse));return reverseReachCache.get(id);};

  const latestEpoch=Number(git(root,['show','-s','--format=%ct','HEAD']));
  const blameCache=new Map();
  const maxDirect=Math.max(0,...production.map(u=>(reverse.get(u.id)??new Set()).size));
  const requiredEvidenceTiers=config.requiredEvidenceTiers??['test','experiment'];
  const halfLifeDays=config.changeHalfLifeDays??30;
  const ln2=Math.log(2);

  const metrics=production.map(u=>{
    const authorityInfluence=[];
    for(const a of authority){
      const uToSink=prodReach(u.id).has(a.unit.id);
      const sinkToU=prodReach(a.unit.id).has(u.id);
      if(uToSink||sinkToU) authorityInfluence.push({id:a.id,direction:uToSink&&sinkToU?'both':uToSink?'controls':'implements',recoveryClass:a.recoveryClass});
    }
    const A=authority.length?authorityInfluence.length/authority.length:0;
    const dependents=[...reverseReach(u.id)].filter(x=>x!==u.id);
    const B=normalizeLog(dependents.length,Math.max(1,production.length-1));
    const direct=(reverse.get(u.id)??new Set()).size;
    const F=Math.sqrt(normalizeLog(direct,maxDirect)*Math.min(1,dependents.length/Math.max(1,production.length-1)));
    const I=(authorityInfluence.length?Math.max(...authorityInfluence.map(x=>x.recoveryClass)):0)/(config.maxRecoveryClass??6);
    const dominated=recovery.filter(s=>scenarioDominators.get(s.id).has(u.id)).map(s=>s.id);
    const R=recovery.length?dominated.length/recovery.length:0;
    const tiers=[];
    if(requiredEvidenceTiers.includes('test') && testEntrypoints.some(t=>allReach(t.id).has(u.id))) tiers.push('test');
    if(requiredEvidenceTiers.includes('experiment') && experimentEntrypoints.some(t=>allReach(t.id).has(u.id))) tiers.push('experiment');
    const reachabilityGap=requiredEvidenceTiers.length?1-(tiers.length/requiredEvidenceTiers.length):0;
    const mutationRequired=requiredMutationUnits.has(u.id);
    const mutationEvidence=mutationEvidenceByUnit.get(u.id)??null;
    let mutationGap=0;
    let mutationRecord=mutationEvidence;
    if(mutationEvidence){
      mutationGap=1-mutationEvidence.mutationScore;
    } else if(mutationRequired){
      mutationGap=1;
      mutationRecord={probeId:null,mutationScore:0,status:'missing',sourceRun:null};
      mutationEvidenceStatus.missing.push({unit:u.id});
    }
    const E=Math.max(reachabilityGap,mutationGap);
    const entrypoints=prodEntrypoints.filter(e=>prodReach(e.id).has(u.id));
    const X=prodEntrypoints.length?entrypoints.length/prodEntrypoints.length:0;
    if(!blameCache.has(u.file)) blameCache.set(u.file,blameTimes(root,u.file));
    const times=blameCache.get(u.file);
    const lineWeights=[];
    for(let line=u.startLine;line<=u.endLine;line++){
      const t=times.get(line);
      if(t){const ageDays=Math.max(0,(latestEpoch-t)/86400);lineWeights.push(Math.exp(-ln2*ageDays/halfLifeDays));}
    }
    const C=lineWeights.length?lineWeights.reduce((a,b)=>a+b,0)/lineWeights.length:0;
    return {
      ...u,
      authorityInfluence,
      dominatedRecoveryScenarios:dominated,
      evidenceTiers:tiers,
      evidence:{reachabilityGap,mutation:mutationRecord,mutationRequired},
      productionEntrypoints:entrypoints.map(e=>e.id),
      raw:{directDependents:direct,transitiveDependents:dependents.length},
      vector:{A,B,I,F,R,E,X,C},
    };
  });

  const consequencePolicy=config.rankingPolicy?.consequence??{
    weights:{A:4,B:2.5,I:3,F:1.5,R:2.5,X:1},
    interactions:{AI:2.5},
  };
  const cw=consequencePolicy.weights;
  const ci=consequencePolicy.interactions??{};
  const consequenceMax=Object.values(cw).reduce((a,b)=>a+b,0)+Object.values(ci).reduce((a,b)=>a+b,0);
  for(const m of metrics){
    const v=m.vector;
    const raw=(cw.A??0)*v.A+(cw.B??0)*v.B+(cw.I??0)*v.I+(cw.F??0)*v.F+(cw.R??0)*v.R+(cw.X??0)*v.X
      +(ci.AI??0)*v.A*v.I;
    m.consequenceScore=100*raw/consequenceMax;
  }

  const attentionPolicy=config.rankingPolicy?.attention??{
    multipliers:{E:1,C:.1,BE:.5},
  };
  const am=attentionPolicy.multipliers??{};
  const attentionMaxFactor=1+Object.values(am).reduce((a,b)=>a+b,0);
  for(const m of metrics){
    const v=m.vector;
    const factor=1+(am.E??0)*v.E+(am.C??0)*v.C+(am.BE??0)*v.B*v.E;
    m.attentionScore=100*(m.consequenceScore/100)*factor/attentionMaxFactor;
  }

  metrics.sort((a,b)=>b.consequenceScore-a.consequenceScore||a.id.localeCompare(b.id));
  metrics.forEach((m,i)=>m.consequenceRank=i+1);
  [...metrics].sort((a,b)=>b.attentionScore-a.attentionScore||a.id.localeCompare(b.id))
    .forEach((m,i)=>m.attentionRank=i+1);

  const metricById=new Map(metrics.map(m=>[m.id,m]));
  const evaluateCalibration=c=>{
    const higher=metricById.get(c.higherUnit.id);
    const lower=metricById.get(c.lowerUnit.id);
    return {id:c.id,kind:c.kind,higher:higher.id,lower:lower.id,higherScore:higher.consequenceScore,lowerScore:lower.consequenceScore,pass:higher.consequenceScore>lower.consequenceScore,rationale:c.rationale??null};
  };
  const requiredCalibrations=requiredCalibration.map(evaluateCalibration);
  const diagnosticCalibrations=diagnosticCalibration.map(evaluateCalibration);
  return {
    schema:'overcenter-production-callable-criticality-experiment/v1',
    revision:git(root,['rev-parse','HEAD']),
    productionRoot:'src/',
    unitKind:'callable',
    analyzer:{
      typescript:ts.version,
      resolvedInternalCalls,
      unresolvedInternalCalls,
      externalCalls,
      unknownCalls,
      byScope:resolutionByScope,
      mutationEvidence:mutationEvidenceStatus,
      unresolvedCallsites:unresolvedCallsites
        .sort((a,b)=>{
          const rank={production:0,test:1,experiment:2,other:3};
          const as=byId.get(a.caller)?.scope??'other';
          const bs=byId.get(b.caller)?.scope??'other';
          return rank[as]-rank[bs]||a.file.localeCompare(b.file)||a.line-b.line||a.expression.localeCompare(b.expression);
        })
        .slice(0,200),
      internalResolutionRate:resolvedInternalCalls+unresolvedInternalCalls+unknownCalls
        ? resolvedInternalCalls/(resolvedInternalCalls+unresolvedInternalCalls+unknownCalls)
        : 1,
    },
    population:{productionCallables:production.length,testCallables:testEntrypoints.length,experimentCallables:experimentEntrypoints.length,productionEntrypoints:prodEntrypoints.length},
    calibration:{
      required:{
        passed:requiredCalibrations.filter(x=>x.pass).length,
        failed:requiredCalibrations.filter(x=>!x.pass).length,
        total:requiredCalibrations.length,
        pairs:requiredCalibrations,
      },
      diagnostic:{
        passed:diagnosticCalibrations.filter(x=>x.pass).length,
        failed:diagnosticCalibrations.filter(x=>!x.pass).length,
        total:diagnosticCalibrations.length,
        pairs:diagnosticCalibrations,
      },
    },
    ranking:metrics.map(({node,...m})=>({
      ...m,
      vector:Object.fromEntries(Object.entries(m.vector).map(([k,v])=>[k,round(v)])),
      consequenceScore:round(m.consequenceScore,2),
      attentionScore:round(m.attentionScore,2),
    })),
  };
}

export function markdown(report,top=30){
  const lines=[
    '# Production callable criticality ranking',
    '',
    `Revision: \`${report.revision}\``,
    '',
    `Population: ${report.population.productionCallables} production callables. Required calibration: ${report.calibration.required.passed}/${report.calibration.required.total}; diagnostic calibration: ${report.calibration.diagnostic.passed}/${report.calibration.diagnostic.total}. Production call resolution: ${(100*report.analyzer.byScope.production.internalResolutionRate).toFixed(1)}%; evidence-call resolution: test ${(100*report.analyzer.byScope.test.internalResolutionRate).toFixed(1)}%, experiment ${(100*report.analyzer.byScope.experiment.internalResolutionRate).toFixed(1)}%.`,
    '',
    '| Consequence rank | Attention rank | Production callable | Consequence | Attention | A | B | I | F | R | E | X | C |',
    '| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for(const m of report.ranking.slice(0,top)){
    const v=m.vector;
    lines.push(`| ${m.consequenceRank} | ${m.attentionRank} | \`${m.file}::${m.qualifiedName}\` | ${m.consequenceScore.toFixed(2)} | ${m.attentionScore.toFixed(2)} | ${v.A.toFixed(2)} | ${v.B.toFixed(2)} | ${v.I.toFixed(2)} | ${v.F.toFixed(2)} | ${v.R.toFixed(2)} | ${v.E.toFixed(2)} | ${v.X.toFixed(2)} | ${v.C.toFixed(2)} |`);
  }
  if(report.analyzer.mutationEvidence){
    lines.push('','## Mutation evidence','');
    lines.push(`Applied probes: ${report.analyzer.mutationEvidence.applied.length}; stale probes: ${report.analyzer.mutationEvidence.stale.length}; missing required units: ${report.analyzer.mutationEvidence.missing.length}.`);
    for(const p of report.analyzer.mutationEvidence.stale) lines.push(`- stale ${p.id}: ${p.staleFiles.map(f=>f.file).join(', ')}`);
    for(const p of report.analyzer.mutationEvidence.missing) lines.push(`- missing hostile-case evidence: ${p.unit}`);
  }
  const requiredFailed=report.calibration.required.pairs.filter(x=>!x.pass);
  const diagnosticFailed=report.calibration.diagnostic.pairs.filter(x=>!x.pass);
  lines.push('','## Calibration','',
    requiredFailed.length?`Required regressions failed: ${requiredFailed.length}.`:'All required calibration regressions passed.',
    diagnosticFailed.length?`Diagnostic disagreements: ${diagnosticFailed.length}.`:'All diagnostic calibration pairs currently agree.');
  for(const p of requiredFailed) lines.push(`- required ${p.id}: expected ${p.higher} (${p.higherScore.toFixed(2)}) > ${p.lower} (${p.lowerScore.toFixed(2)})`);
  for(const p of diagnosticFailed) lines.push(`- diagnostic ${p.id}: expected ${p.higher} (${p.higherScore.toFixed(2)}) > ${p.lower} (${p.lowerScore.toFixed(2)})`);
  if(report.analyzer.unresolvedCallsites?.length){
    lines.push('','## Unresolved internal / unknown callsites','');
    for(const c of report.analyzer.unresolvedCallsites.slice(0,30)){
      lines.push(`- ${c.kind}: \`${c.file}:${c.line}\` \`${c.expression}\` from \`${c.caller}\`${c.declaration_file?` (declaration: \`${c.declaration_file}\`)`:''}`);
    }
  }
  return lines.join('\n')+'\n';
}

function parseArgs(argv){
  const out={root:process.cwd(),config:null,json:null,markdown:null,top:30};
  for(let i=2;i<argv.length;i++){
    const a=argv[i];
    if(a==='--root') out.root=path.resolve(argv[++i]);
    else if(a==='--config') out.config=path.resolve(argv[++i]);
    else if(a==='--json') out.json=path.resolve(argv[++i]);
    else if(a==='--markdown') out.markdown=path.resolve(argv[++i]);
    else if(a==='--top') out.top=Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if(!out.config) throw new Error('--config is required');
  return out;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=parseArgs(process.argv);
  const config=JSON.parse(fs.readFileSync(args.config,'utf8'));
  const report=analyze({root:args.root,config});
  const md=markdown(report,args.top);
  if(args.json) fs.writeFileSync(args.json,JSON.stringify(report,null,2)+'\n');
  if(args.markdown) fs.writeFileSync(args.markdown,md);
  process.stdout.write(md);
  if(report.calibration.required.failed>0) process.exitCode=1;
}
