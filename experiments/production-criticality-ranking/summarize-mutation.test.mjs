import assert from 'node:assert/strict';
import test from 'node:test';
import {summarize} from './summarize-mutation.mjs';

test('attributes mutants only to overlapping semantic probe ranges',()=>{
  const report={files:{
    'src/digest.ts':{mutants:[
      {status:'Killed',location:{start:{line:4},end:{line:4}}},
      {status:'Survived',location:{start:{line:19},end:{line:19}}},
      {status:'Killed',location:{start:{line:30},end:{line:30}}},
    ]},
    'src/kernel-core.ts':{mutants:[
      {status:'NoCoverage',location:{start:{line:450},end:{line:450}}},
    ]},
  }};
  const rows=summarize(report);
  const digest=rows.find(r=>r.id==='digest-foundation');
  const fence=rows.find(r=>r.id==='execution-fence');
  assert.deepEqual({total:digest.total,killed:digest.killed,survived:digest.survived},{total:2,killed:1,survived:1});
  assert.deepEqual({total:fence.total,noCoverage:fence.noCoverage},{total:1,noCoverage:1});
});
