import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import test from 'node:test';

const advance=readFileSync(
  new URL('../.github/workflows/operator-project-advance.yml',import.meta.url),
  'utf8',
);
const signal=readFileSync(
  new URL('../.github/workflows/agent-candidate-signal.yml',import.meta.url),
  'utf8',
);
const submit=readFileSync(
  new URL('../.github/workflows/operator-agent-submit.yml',import.meta.url),
  'utf8',
);

test('reasoning-agent interface exposes semantic project commands',()=>{
  assert.match(advance,/^name: Overcenter command · project\.advance/m);
  assert.match(advance,/command:\n\s+name: project\.advance/);
  assert.match(submit,/^name: Overcenter command · agent\.submit/m);
  assert.match(submit,/command:\n\s+name: agent\.submit/);

  for (const removed of [
    '../.github/workflows/agent-ingress.yml',
    '../.github/workflows/agent-request-signal.yml',
    '../bin/github-agent-ingress.ts',
    '../bin/github-agent-submit.ts',
    '../bin/github-agent-publish-response.ts',
  ]) {
    assert.equal(
      existsSync(new URL(removed,import.meta.url)),
      false,
      `legacy manual agent surface remains: ${removed}`,
    );
  }
});

test('project.advance is a project-scoped trusted rerun command',()=>{
  assert.match(advance,/push:\n\s+branches: \[main\]/);
  assert.match(advance,/if: \$\{\{ github\.run_attempt == 1 \}\}[\s\S]*state: available/);
  assert.match(advance,/COMMAND_IMPLEMENTATION_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(
    advance,
    /Check out trusted command implementation[\s\S]*ref: \$\{\{ env\.COMMAND_IMPLEMENTATION_SHA \}\}/,
  );
  assert.match(advance,/permissions:\n\s+contents: write/);
  assert.doesNotMatch(advance,/workflow_dispatch:|issue_comment:|pull_request_review:/);
  assert.match(advance,/github-project-advance\.ts --output-dir response/);
  assert.match(advance,/steps\.invoke\.outputs\.state == 'AGENT_EXECUTION_REQUIRED'/);
  assert.match(advance,/overcenter-work-packet-\$\{\{ steps\.invoke\.outputs\.run_id \}\}/);
});

test('candidate transport stays internal and inert until agent.submit is invoked',()=>{
  assert.match(signal,/^name: Overcenter internal · candidate handoff/m);
  assert.match(signal,/overcenter\/candidate\/\*\*/);
  assert.match(signal,/permissions: \{\}/);
  assert.doesNotMatch(signal,/contents:\s*write|actions:\s*write/);

  assert.match(submit,/workflow_run:/);
  assert.match(submit,/workflows: \[Overcenter internal · candidate handoff\]/);
  assert.match(submit,/github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(submit,/github\.event\.workflow_run\.actor\.login == github\.repository_owner/);
  assert.match(submit,/startsWith\(github\.event\.workflow_run\.head_branch, 'overcenter\/candidate\/'\)/);
  assert.match(submit,/COMMAND_IMPLEMENTATION_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(submit,/test "\$changed" = "\.overcenter\/candidate\.json"/);
  assert.match(submit,/test "\$branch_run_id" = "\$candidate_run_id"/);
  assert.match(submit,/github-agent-submit-command\.ts --receipt response\/receipt\.json/);
  assert.doesNotMatch(submit,/issue_comment:|pull_request_review:|workflow_dispatch:/);
});

test('operator command workflows stay bounded to one-minute jobs',()=>{
  for (const source of [advance,signal,submit]) {
    assert.match(source,/timeout-minutes: 1/);
  }
});
