import assert from 'node:assert/strict';
import test from 'node:test';
import type { Obligation } from '../src/model.ts';
import type { State } from '../src/facts.ts';
import { validateAdmission } from '../src/admission.ts';
import { githubCommitStatusEffectAuthority } from '../src/provider-effect.ts';

const fileObligation=(id:string,dependencies:Obligation['dependencies']=[]):Obligation=>({
  id,
  dependencies,
  packet:{},
  postcondition:{
    verifier:'file-content-equals/v1',
    path:`/tmp/${id}`,
    content:id,
  },
});

const statusObligation=(
  id:string,
  state:'success'|'failure',
  dependencies:Obligation['dependencies']=[],
):Obligation=>({
  id,
  dependencies,
  packet:{},
  effect_authority:githubCommitStatusEffectAuthority(),
  postcondition:{
    verifier:'github-commit-status/v1',
    provider:'github',
    repository_id:123,
    commit_sha:'a'.repeat(40),
    context:'overcenter/admission',
    expected_state:state,
  },
});

const statusObligationV2=(
  id:string,
  state:'success'|'failure',
  dependencies:Obligation['dependencies']=[],
):Obligation=>({
  id,
  dependencies,
  packet:{},
  effect_authority:githubCommitStatusEffectAuthority(),
  postcondition:{
    verifier:'github-commit-status/v2',
    provider:'github',
    repository_id:123,
    repository_full_name:'owner/repo',
    commit_sha:'a'.repeat(40),
    context:'overcenter/admission',
    expected_state:state,
  },
});

test('admission rejects unsupported semantic selectors before realization',()=>{
  const state:State={
    obligations:{
      a:fileObligation('a'),
      b:fileObligation('b',[{
        kind:'semantic',
        upstream:'a',
        consumes:{kind:'output',selector:'ambient-file'},
      }]),
    },
    definition_commits:{a:'a-def',b:'b-def'},
  };

  assert.throws(
    ()=>validateAdmission(state),
    /UNSUPPORTED_SEMANTIC_SELECTOR:output:ambient-file/,
  );
});

test('admission rejects unordered incompatible static effects',()=>{
  const state:State={
    obligations:{
      alpha:statusObligation('alpha','success'),
      beta:statusObligation('beta','failure'),
    },
    definition_commits:{alpha:'alpha-def',beta:'beta-def'},
  };

  assert.throws(
    ()=>validateAdmission(state),
    /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
  );
});

test('admission accepts explicit ordering for incompatible effects',()=>{
  const state:State={
    obligations:{
      alpha:statusObligation('alpha','success'),
      beta:statusObligation(
        'beta',
        'failure',
        [{kind:'control',upstream:'alpha'}],
      ),
    },
    definition_commits:{alpha:'alpha-def',beta:'beta-def'},
  };

  assert.doesNotThrow(()=>validateAdmission(state));
});

test('admission accepts same-contract identical effects with matching equivalence witnesses',()=>{
  const state:State={
    obligations:{
      alpha:statusObligation('alpha','success'),
      beta:statusObligation('beta','success'),
    },
    definition_commits:{alpha:'alpha-def',beta:'beta-def'},
  };

  assert.doesNotThrow(()=>validateAdmission(state));
});

test('admission rejects cross-verifier overlap without an explicit bridge witness',()=>{
  const state:State={
    obligations:{
      alpha:statusObligation('alpha','success'),
      beta:statusObligationV2('beta','success'),
    },
    definition_commits:{alpha:'alpha-def',beta:'beta-def'},
  };

  assert.throws(
    ()=>validateAdmission(state),
    /UNORDERED_EFFECT_CONFLICT:alpha:beta/,
  );
});


test('observation-only GitHub postconditions do not create mutation conflicts',()=>{
  const alpha=statusObligation('alpha','success');
  const beta=statusObligation('beta','failure');
  delete alpha.effect_authority;
  delete beta.effect_authority;
  const state:State={
    obligations:{alpha,beta},
    definition_commits:{alpha:'alpha-def',beta:'beta-def'},
  };
  assert.doesNotThrow(()=>validateAdmission(state));
});
