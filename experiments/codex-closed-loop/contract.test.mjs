import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const workflow=readFileSync(new URL('../../.github/workflows/codex-closed-loop.yml',import.meta.url),'utf8');
const witness=readFileSync(new URL('./witness.txt',import.meta.url),'utf8');

test('closed-loop witness begins from the controlled precondition',()=>{
  assert.equal(witness,'codex-closed-loop:before\n');
});

test('Codex is isolated from publication authority',()=>{
  assert.match(workflow,/uses: openai\/codex-action@86365089eb2b84e0a8fb0717b304f8bdcb13b20e/);
  assert.match(workflow,/permission-profile: ":workspace"/);
  assert.match(workflow,/safety-strategy: unprivileged-user/);
  assert.match(workflow,/codex-user: overcenter-codex/);
  const worker=workflow.match(/\n  worker:[\s\S]*?\n  verify:/)?.[0]??'';
  assert.match(worker,/permissions:\n      contents: read/);
  assert.doesNotMatch(worker,/contents: write/);
  assert.doesNotMatch(worker,/pull-requests: write/);
});

test('candidate verification is separate from trusted publication',()=>{
  const verify=workflow.match(/\n  verify:[\s\S]*?\n  publish:/)?.[0]??'';
  const publish=workflow.match(/\n  publish:[\s\S]*?\n  observe:/)?.[0]??'';
  assert.match(verify,/needs: \[prepare, worker\]/);
  assert.match(verify,/permissions:\n      contents: read/);
  assert.doesNotMatch(verify,/contents: write/);
  assert.match(publish,/needs: verify/);
  assert.match(publish,/contents: write/);
  assert.match(publish,/pull-requests: write/);
  assert.match(publish,/needs\.verify\.outputs\.patch_sha256/);
});

test('worker candidate is path-confined before settlement',()=>{
  assert.match(workflow,/TARGET_PATH: experiments\/codex-closed-loop\/witness\.txt/);
  assert.match(workflow,/git diff --name-only HEAD/);
  assert.match(workflow,/git ls-files --others --exclude-standard/);
  assert.match(workflow,/git apply --check/);
  assert.match(workflow,/git ls-files -s "\$TARGET_PATH"/);
});
