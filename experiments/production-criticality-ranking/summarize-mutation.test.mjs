import assert from 'node:assert/strict';
import test from 'node:test';
import {summarize} from './summarize-mutation.mjs';

test('attributes mutants only to the active semantic probe ranges',()=>{
  const report={files:{
    'src/digest.ts':{mutants:[
      {status:'Killed',location:{start:{line:4},end:{line:4}}},
      {status:'Timeout',location:{start:{line:19},end:{line:19}}},
      {status:'RuntimeError',location:{start:{line:18},end:{line:18}}},
      {status:'Killed',location:{start:{line:30},end:{line:30}}},
    ]},
    'src/projector.ts':{mutants:[
      {status:'Survived',location:{start:{line:220},end:{line:220}}},
    ]},
  }};
  const rows=summarize(report);
  assert.equal(rows.length,2);
  const digest=rows.find(r=>r.id==='digest-foundation');
  const reuse=rows.find(r=>r.id==='done-candidate-reuse');
  assert.deepEqual({total:digest.total,killed:digest.killed,timeout:digest.timeout,runtimeError:digest.runtimeError,mutationScore:digest.mutationScore},{total:2,killed:1,timeout:1,runtimeError:1,mutationScore:1});
  assert.deepEqual({total:reuse.total,survived:reuse.survived,mutationScore:reuse.mutationScore},{total:1,survived:1,mutationScore:0});
});
