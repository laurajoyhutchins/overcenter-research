import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GitOvercenterKernel } from '../src/storage/git-kernel.ts';
import {
  advanceProjectForAgent,
  submitProjectCandidate,
} from '../src/authority/project-agent-protocol.ts';
import { compileProjectIntent } from '../src/authority/project-intent.ts';
import { hostileMutationEvidenceGraphProducer } from '../src/evidence/hostile-mutation-obligation.ts';
import { SOURCE_VERIFICATION_SCHEMA } from '../src/source/source-integration.ts';
import { brokerAssignedSourceProposal } from '../src/source/source-broker.ts';
import { SOURCE_PROPOSAL_SCHEMA } from '../src/source/source-obligation.ts';

const AUTHORITY_REF = 'refs/overcenter/test-project-agent';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function fixture(): {
  root: string;
  work: string;
  sourceSha: string;
  postconditionRoot: string;
  postconditionPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-project-agent-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  mkdirSync(work);

  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'init', '--initial-branch=main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'config', 'user.name', 'Overcenter Test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'config', 'user.email', 'overcenter-test@local'], {
    stdio: 'ignore',
  });
  writeFileSync(
    join(work, 'task.mjs'),
    "import fs from 'node:fs';\nconst input=fs.readFileSync(process.argv[2],'utf8').trim();\nfs.writeFileSync(process.argv[3],'completed:'+input+'\\n');\n",
  );
  writeFileSync(join(work, 'input.txt'), 'hello\n');
  mkdirSync(join(work, 'src'));
  writeFileSync(join(work, 'src', 'feature.txt'), 'feature:base\n');
  execFileSync('git', ['-C', work, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'commit', '-m', 'seed task source'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', remote], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'push', '-u', 'origin', 'main'], { stdio: 'ignore' });

  const sourceSha = git(work, ['rev-parse', 'HEAD']);
  const postconditionRoot = join('/tmp', `overcenter-agent-${randomUUID()}`);
  const postconditionPath = join(postconditionRoot, 'result.txt');
  return { root, work, sourceSha, postconditionRoot, postconditionPath };
}

function commandContext(sourceSha: string, runId = 9001) {
  return {
    repository_id: 42,
    repository_full_name: 'acme/widget',
    command_source_sha: sourceSha,
    command_run_id: runId,
    command_run_attempt: 2,
  };
}

function workerClientFixture(root: string): string {
  const path = join(root, 'native-overcenter');
  writeFileSync(path, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]));
  return path;
}

function defineAgentWork(work: string, postconditionPath: string): GitOvercenterKernel {
  const kernel = new GitOvercenterKernel(work, { remote: 'origin', ref: AUTHORITY_REF });
  kernel.initialize();
  kernel.define({
    id: 'real-frontier-work',
    packet: {
      schema: 'overcenter-agent-task/v2',
      kind: 'pure-candidate',
      command: ['node', 'task.mjs', 'input.txt', 'result.txt'],
      required_paths: ['task.mjs', 'input.txt'],
      output_path: 'result.txt',
    },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: postconditionPath,
      content: 'completed:hello\n',
    },
  });
  return kernel;
}

function commitProjectIntent(work: string, obligations: unknown[]): string {
  mkdirSync(join(work, '.overcenter'), { recursive: true });
  writeFileSync(
    join(work, '.overcenter', 'project-intent.json'),
    `${JSON.stringify({ schema: 'overcenter-project-intent/v1', obligations }, null, 2)}\n`,
  );
  execFileSync('git', ['-C', work, 'add', '.overcenter/project-intent.json'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'commit', '-m', 'declare project intent'], { stdio: 'ignore' });
  execFileSync('git', ['-C', work, 'push', 'origin', 'main'], { stdio: 'ignore' });
  return git(work, ['rev-parse', 'HEAD']);
}

function agentIntent(id: string, postconditionPath: string) {
  return {
    id,
    task: {
      command: ['node', 'task.mjs', 'input.txt', 'result.txt'],
      required_paths: ['task.mjs', 'input.txt'],
      output_path: 'result.txt',
    },
    postcondition: {
      verifier: 'file-content-equals/v1',
      path: postconditionPath,
      content: 'completed:hello\n',
    },
  };
}

function sourceIntent(id: string) {
  return {
    id,
    task: {
      schema: 'overcenter-source-task/v1',
      kind: 'source-change',
      objective: 'Update the bounded source feature.',
      writable_paths: ['src/feature.txt'],
    },
  };
}

test('checked-in project intent is source-agnostic until trusted compilation', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../.overcenter/project-intent.json', import.meta.url), 'utf8'),
  );
  assert.equal(JSON.stringify(raw).includes('source_sha'), false);

  const desired = compileProjectIntent(raw);
  assert.equal(desired.length, 1);
  const compiled = desired[0];
  assert.ok(compiled);
  assert.equal(compiled.id, 'live-agent-loop-witness');
  assert.ok(compiled.packet);
  assert.deepEqual(compiled.packet.command, [
    'node',
    '--experimental-strip-types',
    'experiments/assignment-capsule/fixture-task.ts',
    'experiments/assignment-capsule/fixture-input.txt',
    'result.txt',
  ]);
  assert.equal(JSON.stringify(compiled.packet).includes('source_sha'), false);
});

test('project.advance reconciles trusted project intent before frontier selection', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();

    const sourceSha = commitProjectIntent(f.work, [
      agentIntent('intent-work', f.postconditionPath),
    ]);
    const outputDir = join(f.root, 'packet');
    const receipt = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir,
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(receipt.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(receipt.obligation_id, 'intent-work');
    const assignment = JSON.parse(readFileSync(join(outputDir, 'assignment.json'), 'utf8'));
    assert.equal(assignment.source_revision, sourceSha);
    assert.equal(JSON.stringify(assignment.work.packet).includes('source_sha'), false);

    const authoritative = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    assert.equal(authoritative.claimedSourceRevision(receipt.run_id!), sourceSha);
    const current = authoritative.inspect();
    assert.equal(current.length, 1);
    assert.equal(current[0].id, 'intent-work');
    assert.equal(current[0].status, 'EXECUTING');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance surfaces READY system evidence without claiming agent work', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();

    const evidenceRoot = join(f.work, 'experiments', 'production-criticality-ranking');
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(
      join(evidenceRoot, 'mutation-probes.json'),
      `${JSON.stringify(
        {
          schema: 'overcenter-criticality-mutation-probes/v1',
          probes: [
            {
              id: 'fixture-proof',
              selectors: [{ file: 'task.mjs', name: 'fixtureTask' }],
              tests: ['test/fixture.test.ts'],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(evidenceRoot, 'mutation-evidence.json'),
      `${JSON.stringify(
        {
          schema: 'overcenter-criticality-mutation-evidence',
          probes: [],
        },
        null,
        2,
      )}\n`,
    );
    execFileSync('git', ['-C', f.work, 'add', 'experiments/production-criticality-ranking'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'commit', '-m', 'configure hostile evidence'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'push', 'origin', 'main'], { stdio: 'ignore' });
    const sourceSha = git(f.work, ['rev-parse', 'HEAD']);

    const outputDir = join(f.root, 'system-evidence-packet');
    const receipt = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir,
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
      graphProducers: [hostileMutationEvidenceGraphProducer],
    });

    assert.equal(receipt.state, 'READY');
    assert.equal(receipt.obligation_id, 'system-evidence:hostile-mutation');
    assert.equal(receipt.run_id, undefined);
    assert.equal(receipt.assignment_sha256, undefined);
    assert.equal(existsSync(outputDir), false);

    const current = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    }).inspect();
    assert.equal(current.length, 1);
    assert.equal(current[0].id, 'system-evidence:hostile-mutation');
    assert.equal(current[0].status, 'READY');
    assert.equal(current[0].run_id, undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project intent is an ensure-set and does not retire unmentioned obligations', () => {
  const f = fixture();
  try {
    defineAgentWork(f.work, f.postconditionPath);
    const sourceSha = commitProjectIntent(f.work, [
      agentIntent('intent-work', f.postconditionPath),
    ]);

    const receipt = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir: join(f.root, 'packet'),
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.ok(receipt.obligation_id);
    assert.ok(['intent-work', 'real-frontier-work'].includes(receipt.obligation_id));

    const current = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    }).inspect();
    assert.deepEqual(
      current.map((work) => work.id),
      ['intent-work', 'real-frontier-work'],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('invalid trusted project intent fails before authority movement', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const before = kernel.head();

    mkdirSync(join(f.work, '.overcenter'), { recursive: true });
    writeFileSync(
      join(f.work, '.overcenter', 'project-intent.json'),
      JSON.stringify({
        schema: 'overcenter-project-intent/v1',
        obligations: [
          {
            ...agentIntent('bad-intent', f.postconditionPath),
            retire: ['something'],
          },
        ],
      }),
    );
    execFileSync('git', ['-C', f.work, 'add', '.overcenter/project-intent.json'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'commit', '-m', 'invalid project intent'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'push', 'origin', 'main'], { stdio: 'ignore' });
    const sourceSha = git(f.work, ['rev-parse', 'HEAD']);

    assert.throws(
      () =>
        advanceProjectForAgent(f.work, commandContext(sourceSha), {
          outputDir: join(f.root, 'packet'),
          authorityRef: AUTHORITY_REF,
          remote: 'origin',
        }),
      /PROJECT_INTENT_OBLIGATION_INVALID:0:UNKNOWN_FIELD:retire/,
    );

    const after = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    assert.equal(after.head(), before);
    assert.deepEqual(after.inspect(), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance selects and claims real READY work, then emits a bounded packet', () => {
  const f = fixture();
  try {
    defineAgentWork(f.work, f.postconditionPath);
    const outputDir = join(f.root, 'packet');
    const receipt = advanceProjectForAgent(f.work, commandContext(f.sourceSha), {
      outputDir,
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(receipt.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(receipt.obligation_id, 'real-frontier-work');
    assert.ok(receipt.run_id);
    assert.ok(receipt.claimed_revision);
    assert.match(receipt.assignment_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(receipt.candidate_branch, `overcenter/candidate/${receipt.run_id}`);
    assert.equal(receipt.candidate_branch_base_sha, f.sourceSha);

    const assignmentBytes = readFileSync(join(outputDir, 'assignment.json'));
    const assignment = JSON.parse(assignmentBytes.toString('utf8'));
    assert.equal(assignment.work.id, 'real-frontier-work');
    assert.equal(assignment.work.status, 'EXECUTING');
    assert.equal(assignment.work.run_id, receipt.run_id);
    assert.equal(assignment.source_revision, f.sourceSha);
    assert.equal(JSON.stringify(assignment.work.packet).includes('source_sha'), false);
    assert.equal(assignmentBytes.includes(Buffer.from('execution_capability')), false);
    assert.deepEqual(
      assignment.files.map((file: { path: string }) => file.path),
      ['task.mjs', 'input.txt'],
    );
    const workerClient = join(outputDir, 'overcenter');
    assert.ok((statSync(workerClient).mode & 0o111) !== 0);
    assert.deepEqual(
      readFileSync(workerClient),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]),
    );

    const current = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    }).inspect();
    assert.equal(current.length, 1, 'project.advance must not manufacture request obligations');
    assert.equal(current[0].id, 'real-frontier-work');
    assert.equal(current[0].status, 'EXECUTING');
    assert.equal(current[0].run_id, receipt.run_id);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance materializes an exact tracked repository tree into a concrete packet', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.work, 'bin'), { recursive: true });
    mkdirSync(join(f.work, 'lib'), { recursive: true });
    writeFileSync(join(f.work, 'bin', 'tool.sh'), '#!/bin/sh\nprintf tree-tool\\n');
    chmodSync(join(f.work, 'bin', 'tool.sh'), 0o755);
    writeFileSync(join(f.work, 'lib', 'nested.txt'), 'tracked-tree-byte\n');
    execFileSync('git', ['-C', f.work, 'add', 'bin/tool.sh', 'lib/nested.txt'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'commit', '-m', 'add tracked source tree'], {
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', f.work, 'push', 'origin', 'main'], { stdio: 'ignore' });
    const sourceSha = git(f.work, ['rev-parse', 'HEAD']);

    // Ambient workspace bytes are deliberately not authority for the packet.
    writeFileSync(join(f.work, 'untracked-secret.txt'), 'must-not-cross-boundary\n');

    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    kernel.define({
      id: 'repository-tree-work',
      packet: {
        schema: 'overcenter-agent-task/v2',
        kind: 'pure-candidate',
        command: ['/bin/true'],
        required_paths: [],
        required_trees: ['.'],
        output_path: 'result.txt',
      },
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: f.postconditionPath,
        content: 'done\n',
      },
    });

    const outputDir = join(f.root, 'tree-packet');
    const receipt = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir,
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(receipt.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(receipt.candidate_branch_base_sha, sourceSha);
    const assignment = JSON.parse(readFileSync(join(outputDir, 'assignment.json'), 'utf8'));
    assert.equal(assignment.source_revision, sourceSha);
    assert.equal('required_trees' in assignment.work.packet, false);

    const files = assignment.files as Array<{
      path: string;
      mode: string;
      content_base64: string;
    }>;
    assert.deepEqual(
      files.map((file) => file.path),
      ['bin/tool.sh', 'input.txt', 'lib/nested.txt', 'src/feature.txt', 'task.mjs'],
    );
    assert.deepEqual(
      assignment.work.packet.required_paths,
      files.map((file) => file.path),
    );
    assert.equal(files.find((file) => file.path === 'bin/tool.sh')?.mode, '100755');
    assert.equal(files.find((file) => file.path === 'lib/nested.txt')?.mode, '100644');
    assert.equal(
      Buffer.from(
        files.find((file) => file.path === 'lib/nested.txt')!.content_base64,
        'base64',
      ).toString('utf8'),
      'tracked-tree-byte\n',
    );
    assert.equal(
      files.some((file) => file.path === 'untracked-secret.txt'),
      false,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project intent accepts repository-tree selectors without embedding a source revision', () => {
  const compiled = compileProjectIntent({
    schema: 'overcenter-project-intent/v1',
    obligations: [
      {
        id: 'tree-intent',
        task: {
          command: ['/bin/true'],
          required_paths: [],
          required_trees: ['src'],
          output_path: 'result.txt',
        },
        postcondition: {
          verifier: 'file-content-equals/v1',
          path: '/tmp/overcenter-tree-intent/result.txt',
          content: 'done\n',
        },
      },
    ],
  });
  assert.equal(compiled.length, 1);
  const compiledTask = compiled[0];
  assert.ok(compiledTask?.packet);
  assert.deepEqual(compiledTask.packet.required_trees, ['src']);
  assert.equal(JSON.stringify(compiledTask.packet).includes('source_sha'), false);
});

test('project.advance emits a source assignment without a worker executable', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const sourceSha = commitProjectIntent(f.work, [sourceIntent('source-work')]);
    const outputDir = join(f.root, 'source-packet');

    const receipt = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir,
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });

    assert.equal(receipt.state, 'AGENT_EXECUTION_REQUIRED');
    assert.equal(receipt.obligation_id, 'source-work');
    assert.equal(receipt.candidate_branch_base_sha, sourceSha);
    assert.ok(receipt.run_id);
    assert.match(receipt.assignment_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(existsSync(join(outputDir, 'overcenter')), false);

    const assignment = JSON.parse(readFileSync(join(outputDir, 'assignment.json'), 'utf8'));
    assert.equal(assignment.schema, 'overcenter-source-assignment/v1');
    assert.equal(assignment.obligation_id, 'source-work');
    assert.equal(assignment.task.kind, 'source-change');
    assert.equal(assignment.claim.run_id, receipt.run_id);
    assert.equal(assignment.claim.source_sha, sourceSha);
    assert.equal(assignment.proposal_schema, SOURCE_PROPOSAL_SCHEMA);
    assert.equal(JSON.stringify(assignment).includes('execution_capability'), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('source proposal broker rejects control-plane mutation before candidate publication', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const sourceSha = commitProjectIntent(f.work, [sourceIntent('source-work')]);
    const acquired = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir: join(f.root, 'source-packet'),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.ok(acquired.run_id);

    const assignment = JSON.parse(
      readFileSync(join(f.root, 'source-packet', 'assignment.json'), 'utf8'),
    );
    const claim = assignment.claim;
    assert.throws(
      () =>
        brokerAssignedSourceProposal(
          f.work,
          assignment,
          {
            schema: SOURCE_PROPOSAL_SCHEMA,
            run_id: claim.run_id,
            claimed_revision: claim.claimed_revision,
            claimed_source_sha: claim.source_sha,
            files: [
              {
                path: '.github/workflows/evil.yml',
                content_base64: Buffer.from('name: evil\n').toString('base64'),
              },
            ],
          },
          { authorityRef: AUTHORITY_REF, remote: 'origin' },
        ),
      /SOURCE_PROPOSAL_PATH_INVALID:0/,
    );

    const candidateRef = `refs/heads/overcenter/candidate/${claim.run_id}`;
    assert.equal(git(f.work, ['ls-remote', 'origin', candidateRef]), '');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.submit integrates a verified source candidate and settles the source obligation', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const sourceSha = commitProjectIntent(f.work, [sourceIntent('source-work')]);
    const acquired = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir: join(f.root, 'source-packet'),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.ok(acquired.run_id);

    const assignment = JSON.parse(
      readFileSync(join(f.root, 'source-packet', 'assignment.json'), 'utf8'),
    );
    const claim = assignment.claim;
    const brokered = brokerAssignedSourceProposal(
      f.work,
      assignment,
      {
        schema: SOURCE_PROPOSAL_SCHEMA,
        run_id: claim.run_id,
        claimed_revision: claim.claimed_revision,
        claimed_source_sha: claim.source_sha,
        files: [
          {
            path: 'src/feature.txt',
            content_base64: Buffer.from('feature:integrated\n').toString('base64'),
          },
        ],
      },
      { authorityRef: AUTHORITY_REF, remote: 'origin' },
    );
    assert.equal(brokered.publication.state, 'PUBLISHED');
    const candidateSha = brokered.candidate.commit_sha;
    const treeSha = git(f.work, ['rev-parse', `${candidateSha}^{tree}`]);
    const verificationPath = join(f.root, 'source-verification.json');
    writeFileSync(
      verificationPath,
      `${JSON.stringify(
        {
          schema: SOURCE_VERIFICATION_SCHEMA,
          state: 'verified',
          run_id: acquired.run_id,
          candidate_sha: candidateSha,
          base_sha: sourceSha,
          tree_sha: treeSha,
          reason: null,
        },
        null,
        2,
      )}\n`,
    );

    const settled = submitProjectCandidate(
      f.work,
      {
        ...commandContext('e'.repeat(40), 9100),
        candidate_sha: candidateSha,
        candidate_run_id: acquired.run_id,
      },
      {
        authorityRef: AUTHORITY_REF,
        remote: 'origin',
        sourceVerificationPath: verificationPath,
      },
    );

    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.verified, true);
    assert.equal(settled.already_settled, false);
    assert.match(settled.integration_commit ?? '', /^[0-9a-f]{40}$/);
    const remoteMain = git(f.work, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
    assert.equal(remoteMain, settled.integration_commit);
    assert.equal(git(f.work, ['show', `${remoteMain}:src/feature.txt`]), 'feature:integrated');

    const authoritative = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    assert.equal(authoritative.inspect()[0].status, 'DONE');

    const replay = submitProjectCandidate(
      f.work,
      {
        ...commandContext('f'.repeat(40), 9101),
        candidate_sha: candidateSha,
        candidate_run_id: acquired.run_id,
      },
      { authorityRef: AUTHORITY_REF, remote: 'origin' },
    );
    assert.equal(replay.disposition, 'DONE');
    assert.equal(replay.already_settled, true);
    assert.equal(replay.integration_commit, settled.integration_commit);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('rejected source verification releases the obligation without moving source authority', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const sourceSha = commitProjectIntent(f.work, [sourceIntent('source-work')]);
    const acquired = advanceProjectForAgent(f.work, commandContext(sourceSha), {
      outputDir: join(f.root, 'source-packet'),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.ok(acquired.run_id);

    const assignment = JSON.parse(
      readFileSync(join(f.root, 'source-packet', 'assignment.json'), 'utf8'),
    );
    const claim = assignment.claim;
    const brokered = brokerAssignedSourceProposal(
      f.work,
      assignment,
      {
        schema: SOURCE_PROPOSAL_SCHEMA,
        run_id: claim.run_id,
        claimed_revision: claim.claimed_revision,
        claimed_source_sha: claim.source_sha,
        files: [
          {
            path: 'src/feature.txt',
            content_base64: Buffer.from('feature:rejected\n').toString('base64'),
          },
        ],
      },
      { authorityRef: AUTHORITY_REF, remote: 'origin' },
    );
    assert.equal(brokered.publication.state, 'PUBLISHED');
    const candidateSha = brokered.candidate.commit_sha;
    const verificationPath = join(f.root, 'source-verification.json');
    writeFileSync(
      verificationPath,
      `${JSON.stringify(
        {
          schema: SOURCE_VERIFICATION_SCHEMA,
          state: 'rejected',
          run_id: acquired.run_id,
          candidate_sha: candidateSha,
          base_sha: sourceSha,
          tree_sha: null,
          reason: 'SOURCE_VERIFICATION_FAILED',
        },
        null,
        2,
      )}\n`,
    );

    const result = submitProjectCandidate(
      f.work,
      {
        ...commandContext('e'.repeat(40), 9200),
        candidate_sha: candidateSha,
        candidate_run_id: acquired.run_id,
      },
      {
        authorityRef: AUTHORITY_REF,
        remote: 'origin',
        sourceVerificationPath: verificationPath,
      },
    );

    assert.equal(result.disposition, 'READY');
    assert.equal(result.verified, false);
    const remoteMain = git(f.work, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
    assert.equal(remoteMain, sourceSha);
    const authoritative = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    });
    assert.equal(authoritative.inspect()[0].status, 'READY');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance requires native client bytes before claiming reasoning work', () => {
  const f = fixture();
  try {
    defineAgentWork(f.work, f.postconditionPath);
    const before = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    const head = before.head();

    assert.throws(
      () =>
        advanceProjectForAgent(f.work, commandContext(f.sourceSha), {
          outputDir: join(f.root, 'packet'),
          authorityRef: AUTHORITY_REF,
          remote: 'origin',
        }),
      /PROJECT_ADVANCE_WORKER_CLIENT_REQUIRED/,
    );

    const after = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    assert.equal(after.head(), head);
    assert.equal(after.inspect()[0].status, 'READY');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('unsupported READY work fails before authority is claimed', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    kernel.define({
      id: 'deterministic-effect',
      packet: { schema: 'provider-effect/v1', kind: 'provider-effect' },
      postcondition: {
        verifier: 'file-content-equals/v1',
        path: f.postconditionPath,
        content: 'done\n',
      },
    });
    const before = kernel.head();

    assert.throws(
      () =>
        advanceProjectForAgent(f.work, commandContext(f.sourceSha), {
          outputDir: join(f.root, 'packet'),
          authorityRef: AUTHORITY_REF,
          remote: 'origin',
        }),
      /PROJECT_ADVANCE_AGENT_PACKET_UNSUPPORTED/,
    );

    const after = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    assert.equal(after.head(), before);
    assert.equal(after.inspect()[0].status, 'READY');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.submit validates exact packet identity and settles independently', () => {
  const f = fixture();
  try {
    defineAgentWork(f.work, f.postconditionPath);
    const outputDir = join(f.root, 'packet');
    const acquired = advanceProjectForAgent(f.work, commandContext(f.sourceSha), {
      outputDir,
      workerClientPath: workerClientFixture(f.root),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.equal(acquired.state, 'AGENT_EXECUTION_REQUIRED');
    assert.ok(acquired.run_id);
    assert.ok(acquired.claimed_revision);
    assert.ok(acquired.assignment_sha256);

    const output = Buffer.from('completed:hello\n');
    const candidate = {
      schema: 'overcenter-agent-candidate/v1',
      assignment_sha256: acquired.assignment_sha256,
      obligation_id: acquired.obligation_id,
      run_id: acquired.run_id,
      claimed_revision: acquired.claimed_revision,
      output_path: 'result.txt',
      output_sha256: createHash('sha256').update(output).digest('hex'),
      output_base64: output.toString('base64'),
    };
    mkdirSync(join(f.work, '.overcenter'), { recursive: true });
    writeFileSync(
      join(f.work, '.overcenter', 'candidate.json'),
      `${JSON.stringify(candidate, null, 2)}\n`,
    );
    execFileSync('git', ['-C', f.work, 'add', '.overcenter/candidate.json'], { stdio: 'ignore' });
    execFileSync('git', ['-C', f.work, 'commit', '-m', 'candidate bytes'], { stdio: 'ignore' });
    const candidateSha = git(f.work, ['rev-parse', 'HEAD']);

    const settled = submitProjectCandidate(
      f.work,
      {
        ...commandContext('e'.repeat(40), 9002),
        candidate_sha: candidateSha,
        candidate_run_id: acquired.run_id,
      },
      { authorityRef: AUTHORITY_REF, remote: 'origin' },
    );
    assert.equal(settled.disposition, 'DONE');
    assert.equal(settled.verified, true);
    assert.equal(settled.already_settled, false);
    assert.equal(settled.run_id, acquired.run_id);
    assert.ok(settled.settlement_commit);

    const current = new GitOvercenterKernel(f.work, {
      remote: 'origin',
      ref: AUTHORITY_REF,
    }).inspect();
    assert.equal(current[0].status, 'DONE');

    const replay = submitProjectCandidate(
      f.work,
      {
        ...commandContext('f'.repeat(40), 9003),
        candidate_sha: candidateSha,
        candidate_run_id: acquired.run_id,
      },
      { authorityRef: AUTHORITY_REF, remote: 'origin' },
    );
    assert.equal(replay.disposition, 'DONE');
    assert.equal(replay.verified, true);
    assert.equal(replay.already_settled, true);
    assert.equal(replay.settlement_commit, settled.settlement_commit);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});

test('project.advance reports DONE for an empty authoritative graph', () => {
  const f = fixture();
  try {
    const kernel = new GitOvercenterKernel(f.work, { remote: 'origin', ref: AUTHORITY_REF });
    kernel.initialize();
    const receipt = advanceProjectForAgent(f.work, commandContext(f.sourceSha), {
      outputDir: join(f.root, 'packet'),
      authorityRef: AUTHORITY_REF,
      remote: 'origin',
    });
    assert.equal(receipt.state, 'DONE');
    assert.equal(receipt.run_id, undefined);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(f.postconditionRoot, { recursive: true, force: true });
  }
});
