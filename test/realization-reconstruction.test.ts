import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256 } from '../src/digest.ts';
import { GitFactStore } from '../src/git-store.ts';
import {
  reusableRealization,
  verifyRealizationCandidate,
  type RealizationContract,
  type VerifiedRealizationFact,
} from '../src/realization.ts';

const REF='refs/overcenter/realization-proof';
const OUTPUT='producer-independent artifact';

function contract():RealizationContract {
  return {
    packet:{command:'compile'},
    semantic_dependencies:[{selector:'source-tree',identity:'git-tree:abc'}],
    verifier_identity:'artifact-sha256/v1',
    material_configuration:{target:'linux-x64'},
    source_inputs:{commit:'a'.repeat(40)},
    acceptance_predicate:{kind:'sha256-equals/v1',expected_sha256:sha256(OUTPUT)},
    reuse_mode:'content-addressed',
  };
}

function readFacts(store:GitFactStore):VerifiedRealizationFact[] {
  const head=store.head();
  if (!head) return [];
  return store.revisions(head)
    .map(commit=>store.readJson(commit,'realization.json'))
    .filter((fact):fact is VerifiedRealizationFact=>fact!==null);
}

test('reuse reconstructs identically from durable Git facts after all materialized cache is deleted',()=>{
  const root=mkdtempSync(join(tmpdir(),'overcenter-realization-reuse-'));
  const authority=join(root,'authority.git');
  const cache=join(root,'materialized');
  execFileSync('git',['init','--bare',authority],{stdio:'ignore'});

  try {
    const store=new GitFactStore(authority,{ref:REF});
    const initial=store.createCommit(null,'initialize realization proof');
    assert.equal(store.cas(initial,store.zeroObjectId()),true);

    const current=contract();
    const fact=verifyRealizationCandidate(current,{
      producer:{kind:'human',id:'human-builder'},
      content:OUTPUT,
    });
    const head=store.head()!;
    const recorded=store.createCommit(
      head,
      'record verified realization',
      {'realization.json':fact},
    );
    assert.equal(store.cas(recorded,head),true);

    const before=reusableRealization(current,readFacts(store));
    assert.equal(before.satisfied,true);

    mkdirSync(cache,{recursive:true});
    writeFileSync(join(cache,'reuse-index.json'),`${JSON.stringify(before,null,2)}\n`);
    assert.equal(existsSync(cache),true);
    rmSync(cache,{recursive:true,force:true});
    assert.equal(existsSync(cache),false);

    const reconstructedRepo=join(root,'reconstructor.git');
    execFileSync('git',['init','--bare',reconstructedRepo],{stdio:'ignore'});
    execFileSync('git',['-C',reconstructedRepo,'remote','add','origin',authority]);
    execFileSync(
      'git',
      ['-C',reconstructedRepo,'fetch','--no-tags','origin',`+${REF}:${REF}`],
      {stdio:'ignore'},
    );
    const freshStore=new GitFactStore(reconstructedRepo,{ref:REF});
    const after=reusableRealization(current,readFacts(freshStore));
    assert.deepEqual(after,before);

    const changed={...current,source_inputs:{commit:'b'.repeat(40)}};
    assert.equal(reusableRealization(changed,readFacts(freshStore)).satisfied,false);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
