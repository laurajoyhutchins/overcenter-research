import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const advance = readFileSync(
  new URL('../.github/workflows/operator-project-advance.yml', import.meta.url),
  'utf8',
);
const signal = readFileSync(
  new URL('../.github/workflows/agent-candidate-signal.yml', import.meta.url),
  'utf8',
);
const submit = readFileSync(
  new URL('../.github/workflows/operator-project-submit.yml', import.meta.url),
  'utf8',
);

test('reasoning-agent interface exposes semantic project commands', () => {
  assert.match(advance, /^name: Overcenter command · project\.advance/m);
  assert.match(advance, /command:\n\s+name: project\.advance/);
  assert.match(submit, /^name: Overcenter command · project\.submit/m);
  assert.match(submit, /command:\n\s+name: project\.submit/);

  for (const removed of [
    '../.github/workflows/agent-ingress.yml',
    '../.github/workflows/agent-request-signal.yml',
    '../src/cli/github-agent-ingress.ts',
    '../src/cli/github-agent-submit.ts',
    '../src/cli/github-agent-publish-response.ts',
  ]) {
    assert.equal(
      existsSync(new URL(removed, import.meta.url)),
      false,
      `legacy manual agent surface remains: ${removed}`,
    );
  }
});

test('project.advance is a project-scoped trusted rerun command', () => {
  assert.match(advance, /push:\n\s+branches: \[main\]/);
  assert.match(advance, /if: \$\{\{ github\.run_attempt == 1 \}\}[\s\S]*state: available/);
  assert.match(advance, /COMMAND_IMPLEMENTATION_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(
    advance,
    /Check out trusted command implementation[\s\S]*ref: \$\{\{ env\.COMMAND_IMPLEMENTATION_SHA \}\}/,
  );
  assert.match(advance, /permissions:\n\s+contents: write/);
  assert.doesNotMatch(advance, /workflow_dispatch:|issue_comment:|pull_request_review:/);
  assert.match(advance, /project-advance\.ts --output-dir response/);
  assert.match(advance, /steps\.invoke\.outputs\.state == 'AGENT_EXECUTION_REQUIRED'/);
  assert.match(advance, /overcenter-work-packet-\$\{\{ steps\.invoke\.outputs\.run_id \}\}/);
});

test('candidate transport stays internal and inert until project.submit is invoked', () => {
  assert.match(signal, /^name: Overcenter internal · candidate handoff/m);
  assert.match(signal, /overcenter\/candidate\/\*\*/);
  assert.match(signal, /paths:\n\s+- '\.overcenter\/candidate\.json'/);
  assert.match(signal, /permissions: \{\}/);
  assert.doesNotMatch(signal, /contents:\s*write|actions:\s*write/);

  assert.match(submit, /workflow_run:/);
  assert.match(submit, /workflows: \[Overcenter internal · candidate handoff\]/);
  assert.match(
    submit,
    /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/,
  );
  assert.match(submit, /github\.event\.workflow_run\.actor\.login == github\.repository_owner/);
  assert.match(
    submit,
    /startsWith\(github\.event\.workflow_run\.head_branch, 'overcenter\/candidate\/'\)/,
  );
  assert.match(submit, /COMMAND_IMPLEMENTATION_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(submit, /id: transport/);
  assert.match(submit, /if \[ "\$changed" = "\.overcenter\/candidate\.json" \]; then/);
  assert.match(submit, /test "\$branch_run_id" = "\$candidate_run_id"/);
  assert.match(
    submit,
    /OVERCENTER_CANDIDATE_RUN_ID: \$\{\{ steps\.transport\.outputs\.candidate_run_id \}\}/,
  );
  assert.match(submit, /Download source verification/);
  assert.match(submit, /overcenter-source-verification/);
  assert.match(submit, /project-submit\.ts --receipt response\/receipt\.json/);
  assert.doesNotMatch(submit, /issue_comment:|pull_request_review:|workflow_dispatch:/);
});

test('source candidate verification reuses exact evidence without repository write authority', () => {
  assert.match(signal, /source-evidence:\n\s+name: Verify source candidate/);
  assert.match(signal, /source-evidence:[\s\S]*permissions:\n\s+contents: read/);
  assert.match(signal, /uses: \.\/\.github\/workflows\/tests\.yml/);
  assert.match(signal, /expensive: true/);
  assert.doesNotMatch(signal, /contents:\s*write|actions:\s*write/);
  assert.match(signal, /source-record:[\s\S]*persist-credentials: false/);
  assert.match(signal, /needs\.source-evidence\.result/);
  assert.match(signal, /source-verification\/source-verification\.json/);
});

test('routine operator commands require no GitHub App credential', () => {
  for (const source of [advance, submit]) {
    assert.ok(source.includes('GITHUB_TOKEN: ${{ github.token }}'));
    assert.doesNotMatch(source, /GITHUB_APP|APP_ID|PRIVATE_KEY|INSTALLATION_ID/i);
  }
});

test('semantic operator commands do not spend their budget on package-manager caching', () => {
  for (const source of [advance, submit]) {
    assert.match(source, /package-manager-cache: false/);
  }
});

test('operator command workflows stay bounded to one-minute jobs', () => {
  for (const source of [advance, signal, submit]) {
    assert.match(source, /timeout-minutes: 1/);
  }
});
