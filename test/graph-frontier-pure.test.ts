import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStressGraph } from '../experiments/go-graph-executor/stress-fixture.ts';

test('1,000-node hostile graph derives the exact executable frontier before Go sees it',()=>{
  const {state,frontier}=buildStressGraph();
  assert.equal(Object.keys(state.obligations).length,1000);
  assert.equal(frontier.length,760);

  const ids=new Set(frontier.map(work=>work.id));
  for (let index=0;index<700;index+=1) {
    assert.equal(ids.has(`independent-${String(index).padStart(3,'0')}`),true);
  }
  for (let chain=0;chain<10;chain+=1) {
    assert.equal(ids.has(`chain-${String(chain).padStart(2,'0')}-00`),true);
    for (let depth=1;depth<10;depth+=1) {
      assert.equal(
        ids.has(`chain-${String(chain).padStart(2,'0')}-${String(depth).padStart(2,'0')}`),
        false,
      );
    }
  }
  for (let pair=0;pair<50;pair+=1) {
    assert.equal(ids.has(`conflict-${String(pair).padStart(2,'0')}-success`),false);
    assert.equal(ids.has(`conflict-${String(pair).padStart(2,'0')}-failure`),false);
  }
  for (let index=0;index<50;index+=1) {
    assert.equal(ids.has(`reused-${String(index).padStart(2,'0')}`),false);
  }
  for (let index=0;index<25;index+=1) {
    assert.equal(ids.has(`fail-${String(index).padStart(2,'0')}`),true);
    assert.equal(ids.has(`hang-${String(index).padStart(2,'0')}`),true);
  }
});
