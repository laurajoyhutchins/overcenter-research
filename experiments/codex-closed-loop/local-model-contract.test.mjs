import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const workflow=readFileSync(new URL('../../.github/workflows/autonomy-sandbox-local-model.yml',import.meta.url),'utf8');

test('local model proof has no provider mutation credential or publication authority',()=>{
  assert.match(workflow,/permissions:\n  contents: read/);
  assert.doesNotMatch(workflow,/contents: write/);
  assert.doesNotMatch(workflow,/pull-requests: write/);
  assert.doesNotMatch(workflow,/statuses: write/);
  assert.doesNotMatch(workflow,/OPENAI_API_KEY/);
  assert.doesNotMatch(workflow,/^\s+GITHUB_TOKEN:\s/m);
  assert.match(workflow,/persist-credentials: false/g);
});

test('local inference is pinned and loses networking before model execution',()=>{
  assert.match(workflow,/MODEL_REVISION: 0d4b0eeb9675b2da6dfaeb6fbf2ef1dff3e71e29/);
  assert.match(workflow,/MODEL_SHA256: 1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32/);
  assert.match(workflow,/RUNTIME_SHA256: 9abf88aea48a55d0f80edb1ee20220b186848cca0b4e919d71518cfd7ca67443/);
  assert.match(workflow,/sha256sum --check -/);
  assert.match(workflow,/useradd --no-create-home --shell \/usr\/sbin\/nologin overcenter-model/);
  assert.match(workflow,/rm -rf "\$GITHUB_WORKSPACE"/);
  assert.match(workflow,/mkdir -m 0700 "\$GITHUB_WORKSPACE"/);
  assert.match(workflow,/find "\$GITHUB_WORKSPACE" -mindepth 1 -print -quit/);
  assert.match(workflow,/cd "\$HOME"/);
  assert.match(workflow,/\/usr\/bin\/unshare --net --fork --[\s\S]*\/usr\/bin\/setpriv --reuid=/);
  assert.match(workflow,/readlink \/proc\/self\/ns\/net/);
  assert.match(workflow,/\/proc\/net\/dev/);
  assert.match(workflow,/test -z "\$non_loopback"/);
  assert.match(workflow,/--json-schema-file/);
  assert.match(workflow,/--seed 20260921/);
  assert.match(workflow,/--temp 0/);
});

test('candidate crosses a fresh-runner boundary before trusted settlement',()=>{
  const model=workflow.match(/\n  model:[\s\S]*?\n  verify:/)?.[0]??'';
  const verify=workflow.match(/\n  verify:[\s\S]*$/)?.[0]??'';
  assert.match(model,/Upload untrusted candidate only/);
  assert.match(model,/rm -rf "\$GITHUB_WORKSPACE"/);
  assert.doesNotMatch(model,/sandbox-runner\.ts/);
  assert.doesNotMatch(model,/contents: write|pull-requests: write|statuses: write/);
  assert.match(verify,/needs: model/);
  assert.match(verify,/sandbox-runner\.ts/);
  assert.match(verify,/rustc --edition=2021 -D warnings runtime\/overcenter-exec\/main\.rs/);
  assert.match(verify,/--launcher "\$RUNNER_TEMP\/overcenter-exec"/);
  assert.match(verify,/execution_confinement_proven/);
  assert.match(verify,/Fresh trusted verification and settlement/);
});
