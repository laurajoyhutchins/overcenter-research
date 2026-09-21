import assert from 'node:assert/strict';
import test from 'node:test';

import type { State } from '../src/facts.ts';
import { normalizeObligation } from '../src/facts.ts';
import { planGraphReconciliation } from '../src/graph-reconciliation.ts';

const pc=(path:string,content:string)=>({
  verifier:'file-content-equals/v1' as const,
  path,
  content,
});

test('graph reconciliation deterministically classifies add replace and unchanged',()=>{
  const state:State={
    obligations:{
      unchanged:normalizeObligation({
        id:'unchanged',
        dependencies:[
          {kind:'control',upstream:'root'},
          {kind:'control',upstream:'other'},
        ],
        packet:{value:1},
        postcondition:pc('/tmp/unchanged','A'),
      }),
      changed:normalizeObligation({
        id:'changed',
        packet:{value:1},
        postcondition:pc('/tmp/changed','A'),
      }),
    },
    definition_commits:{
      unchanged:'u-def',
      changed:'c-def',
    },
  };

  const plan=planGraphReconciliation(state,[
    {
      id:'new',
      postcondition:pc('/tmp/new','N'),
    },
    {
      id:'changed',
      packet:{value:2},
      postcondition:pc('/tmp/changed','A'),
    },
    {
      id:'unchanged',
      dependencies:[
        {kind:'control',upstream:'other'},
        {kind:'control',upstream:'root'},
      ],
      packet:{value:1},
      postcondition:pc('/tmp/unchanged','A'),
    },
  ]);

  assert.deepEqual(plan.add.map(({id})=>id),['new']);
  assert.deepEqual(plan.replace.map(({id})=>id),['changed']);
  assert.deepEqual(plan.unchanged,['unchanged']);
});

test('graph reconciliation rejects duplicate desired identities',()=>{
  const state:State={obligations:{},definition_commits:{}};
  assert.throws(
    ()=>planGraphReconciliation(state,[
      {id:'a',postcondition:pc('/tmp/a','A')},
      {id:'a',postcondition:pc('/tmp/a','A')},
    ]),
    /DUPLICATE_DESIRED_OBLIGATION:a/,
  );
});
