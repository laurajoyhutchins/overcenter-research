import assert from 'node:assert/strict';
import test from 'node:test';
import {summarize} from './summarize-mutation.ts';

test('attributes mutants only to semantic probe ranges',()=>{
  const report={files:{
    'src/digest.ts':{mutants:[
      {id:'1',status:'Killed',location:{start:{line:4},end:{line:4}}},
      {id:'2',status:'Survived',location:{start:{line:19},end:{line:19}}},
      {id:'3',status:'Killed',location:{start:{line:30},end:{line:30}}},
    ]},
    'src/kernel-core.ts':{mutants:[
      {id:'4',status:'NoCoverage',location:{start:{line:450},end:{line:450}}},
    ]},
  }};
  const resolved={probes:[
    {id:'digest-foundation',ranges:[{file:'src/digest.ts',start:3,end:20}]},
    {id:'execution-fence',ranges:[{file:'src/kernel-core.ts',start:446,end:462}]},
  ]};
  const rows=summarize(report,resolved);
  const digest=rows.find(r=>r.id==='digest-foundation');
  const fence=rows.find(r=>r.id==='execution-fence');
  assert.deepEqual({total:digest.total,killed:digest.killed,survived:digest.survived},{total:2,killed:1,survived:1});
  assert.deepEqual({total:fence.total,noCoverage:fence.noCoverage},{total:1,noCoverage:1});
});
