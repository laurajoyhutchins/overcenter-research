import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { validateAdmission } from '../../src/admission.ts';
import { canonicalDigest } from '../../src/digest.ts';
import type { State } from '../../src/facts.ts';
import type { Dependency, Obligation } from '../../src/model.ts';

const kernel='./experiments/lean-kernel/.lake/build/bin/overcenterKernel';
const SHA='a'.repeat(40);

function status(
  id:string,
  {
    repositoryId=123,
    sha=SHA,
    context='Overcenter/Proof',
    expectedState='success',
    dependencies=[],
  }:{
    repositoryId?:number;
    sha?:string;
    context?:string;
    expectedState?:'error'|'failure'|'pending'|'success';
    dependencies?:Dependency[];
  }={},
):Obligation {
  return {
    id,
    dependencies,
    packet:{purpose:id},
    postcondition:{
      verifier:'github-commit-status/v2',
      provider:'github',
      repository_id:repositoryId,
      repository_full_name:'example/repo',
      commit_sha:sha,
      context,
      expected_state:expectedState,
    },
  };
}

function tsValid(obligations:Obligation[]):boolean {
  const state:State={
    obligations:Object.fromEntries(obligations.map(obligation=>[
      obligation.id,
      structuredClone(obligation),
    ])),
    definition_commits:Object.fromEntries(obligations.map((obligation,index)=>[
      obligation.id,
      `definition-${index}`,
    ])),
  };
  try {
    validateAdmission(state);
    return true;
  } catch {
    return false;
  }
}

function leanObligation(obligation:Obligation) {
  assert.equal(obligation.postcondition.verifier,'github-commit-status/v2');
  if(obligation.postcondition.verifier!=='github-commit-status/v2') {
    throw new Error('unsupported fixture');
  }
  return {
    id:obligation.id,
    packet_identity:canonicalDigest(obligation.packet),
    postcondition:{
      family:'github-commit-status',
      verifier_revision:'github-commit-status/v2@semantics-1',
      coordinate:{
        repository_id:obligation.postcondition.repository_id,
        commit_sha:obligation.postcondition.commit_sha,
        context:obligation.postcondition.context,
      },
      expected:obligation.postcondition.expected_state,
    },
    dependencies:obligation.dependencies.map(dependency=>
      dependency.kind==='control'
        ? {kind:'control',upstream:dependency.upstream}
        : {
            kind:'semantic',
            upstream:dependency.upstream,
            selector:dependency.consumes.selector,
          }),
  };
}

function leanValid(obligations:Obligation[]):boolean {
  const stdout=execFileSync(kernel,[],{
    input:JSON.stringify({
      command:'claim-effect-ordering',
      obligations:obligations.map(leanObligation),
    }),
    encoding:'utf8',
    stdio:['pipe','pipe','pipe'],
  });
  const response=JSON.parse(stdout) as {schema:string;valid:boolean};
  assert.equal(response.schema,'overcenter-lean-kernel/v1');
  return response.valid;
}

test('Lean and TypeScript agree on static GitHub status effect ordering',()=>{
  const cases:Array<{
    name:string;
    obligations:Obligation[];
    expected:boolean;
  }>=[
    {
      name:'unordered incompatible states conflict',
      obligations:[
        status('success'),
        status('failure',{expectedState:'failure'}),
      ],
      expected:false,
    },
    {
      name:'context identity is case-insensitive',
      obligations:[
        status('success',{context:'Overcenter/Proof'}),
        status('failure',{context:'overcenter/proof',expectedState:'failure'}),
      ],
      expected:false,
    },
    {
      name:'identical desired state commutes',
      obligations:[
        status('success-a',{context:'Overcenter/Proof'}),
        status('success-b',{context:'OVERCENTER/PROOF'}),
      ],
      expected:true,
    },
    {
      name:'different context is independent',
      obligations:[
        status('success'),
        status('failure',{
          context:'Overcenter/Other',
          expectedState:'failure',
        }),
      ],
      expected:true,
    },
    {
      name:'different repository is independent',
      obligations:[
        status('success'),
        status('failure',{
          repositoryId:456,
          expectedState:'failure',
        }),
      ],
      expected:true,
    },
    {
      name:'different commit is independent',
      obligations:[
        status('success'),
        status('failure',{
          sha:'b'.repeat(40),
          expectedState:'failure',
        }),
      ],
      expected:true,
    },
    {
      name:'dependency orders incompatible writes',
      obligations:[
        status('success'),
        status('failure',{
          expectedState:'failure',
          dependencies:[{kind:'control',upstream:'success'}],
        }),
      ],
      expected:true,
    },
    {
      name:'reverse dependency also orders incompatible writes',
      obligations:[
        status('success',{
          dependencies:[{kind:'control',upstream:'failure'}],
        }),
        status('failure',{expectedState:'failure'}),
      ],
      expected:true,
    },
  ];

  for(const candidate of cases) {
    assert.equal(tsValid(candidate.obligations),candidate.expected,`${candidate.name}: TypeScript`);
    assert.equal(leanValid(candidate.obligations),candidate.expected,`${candidate.name}: Lean`);
  }
});
