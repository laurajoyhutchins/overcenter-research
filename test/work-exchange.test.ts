import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assignmentFile,
  assignmentSha256,
  buildAssignment,
  encodeAssignment,
} from '../src/execution/assignment-capsule.ts';
import {
  executeWorkPacket,
  type WorkExchangeRun,
} from '../src/execution/work-exchange.ts';
import { canonicalDigest, sha256 } from '../src/digest.ts';

function assignmentBytes(): Buffer {
  return encodeAssignment(
    buildAssignment(
      {
        id: 'proof',
        revision: 'revision-1',
        status: 'EXECUTING',
        run_id: 'run-1',
        claimed_revision: 'claim-1',
        execution_generation: 1,
        packet: {
          schema: 'overcenter-agent-task/v2',
          kind: 'pure-candidate',
          command: ['node', 'task.ts'],
          required_paths: ['task.ts'],
          output_path: 'result.txt',
        },
      },
      [assignmentFile('task.ts', 'process.exit(0)\n')],
      '1'.repeat(40),
    ),
  );
}

function receipt(assignment: Buffer) {
  const unsigned = {
    schema: 'overcenter-project-advance/v1',
    command: 'project.advance',
    transport: 'github-actions-job-rerun',
    repository_id: 42,
    repository_full_name: 'acme/widget',
    command_source_sha: '1'.repeat(40),
    command_run_id: 9001,
    command_run_attempt: 2,
    authority_ref: 'refs/overcenter/state',
    authority_head: '2'.repeat(40),
    state: 'AGENT_EXECUTION_REQUIRED',
    obligation_id: 'proof',
    run_id: 'run-1',
    claimed_revision: 'claim-1',
    assignment_sha256: assignmentSha256(assignment),
    candidate_branch: 'overcenter/candidate/run-1',
    candidate_branch_base_sha: '1'.repeat(40),
  };
  return {
    ...unsigned,
    receipt_digest: canonicalDigest(unsigned),
  };
}

function candidateBytes(assignment: Buffer, output = Buffer.from('done\n')): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schema: 'overcenter-agent-candidate/v1',
        assignment_sha256: assignmentSha256(assignment),
        obligation_id: 'proof',
        run_id: 'run-1',
        claimed_revision: 'claim-1',
        output_path: 'result.txt',
        output_sha256: sha256(output),
        output_base64: output.toString('base64'),
      },
      null,
      2,
    )}\n`,
  );
}

function fixture(): {
  root: string;
  packet: string;
  output: string;
  assignment: Buffer;
} {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-work-exchange-test-'));
  const packet = join(root, 'packet');
  const output = join(root, 'output');
  mkdirSync(packet);
  const assignment = assignmentBytes();
  writeFileSync(join(packet, 'assignment.json'), assignment);
  writeFileSync(join(packet, 'receipt.json'), `${JSON.stringify(receipt(assignment), null, 2)}\n`);
  writeFileSync(join(packet, 'overcenter'), 'worker');
  chmodSync(join(packet, 'overcenter'), 0o755);
  return { root, packet, output, assignment };
}

function gitBlobSha1(bytes: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
}

test('one exchange validates packet, executes worker, and emits deterministic publication plan', () => {
  const f = fixture();
  try {
    const produced = candidateBytes(f.assignment);
    let calls = 0;
    const run: WorkExchangeRun = (command, args, options) => {
      calls += 1;
      assert.equal(command, join(f.packet, 'overcenter'));
      assert.equal(args[0], 'run');
      assert.equal(args[1], join(f.packet, 'assignment.json'));
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.ACTIONS_RUNTIME_TOKEN, undefined);
      assert.equal(options.env.OVERCENTER_GITHUB_TOKEN, undefined);
      writeFileSync(args[3]!, produced);
      return { status: 0, signal: null };
    };

    const result = executeWorkPacket(f.packet, f.output, {
      run,
      processEnv: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp/home',
        GITHUB_TOKEN: 'must-not-cross',
        GH_TOKEN: 'must-not-cross',
        ACTIONS_RUNTIME_TOKEN: 'must-not-cross',
        OVERCENTER_GITHUB_TOKEN: 'must-not-cross',
      },
    });

    assert.equal(calls, 1);
    assert.deepEqual(readFileSync(result.candidate_path), produced);
    assert.equal(result.candidate.run_id, 'run-1');
    assert.deepEqual(result.publication_plan, {
      schema: 'overcenter-candidate-publication',
      schema_version: 1,
      repository_full_name: 'acme/widget',
      run_id: 'run-1',
      parent_commit: '1'.repeat(40),
      branch: 'overcenter/candidate/run-1',
      path: '.overcenter/candidate.json',
      candidate_sha256: sha256(produced),
      candidate_git_blob_sha1: gitBlobSha1(produced),
      candidate_content_base64: produced.toString('base64'),
      commit_message: 'Submit Overcenter candidate run-1',
    });
    assert.deepEqual(
      JSON.parse(readFileSync(result.publication_plan_path, 'utf8')),
      result.publication_plan,
    );
    assert.equal(result.receipt_sha256, sha256(readFileSync(join(f.packet, 'receipt.json'))));
    assert.equal(result.worker_client_sha256, sha256('worker'));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('packet membership and receipt identity fail before worker execution', () => {
  const f = fixture();
  try {
    let calls = 0;
    const run: WorkExchangeRun = () => {
      calls += 1;
      return { status: 0, signal: null };
    };

    writeFileSync(join(f.packet, 'ambient-secret'), 'must not cross\n');
    assert.throws(
      () => executeWorkPacket(f.packet, f.output, { run }),
      /WORK_EXCHANGE_PACKET_MEMBERSHIP_INVALID/,
    );
    assert.equal(calls, 0);

    rmSync(join(f.packet, 'ambient-secret'));
    const wrong = receipt(f.assignment);
    wrong.run_id = 'other-run';
    const { receipt_digest: _ignored, ...unsigned } = wrong;
    wrong.receipt_digest = canonicalDigest(unsigned);
    writeFileSync(join(f.packet, 'receipt.json'), `${JSON.stringify(wrong, null, 2)}\n`);

    assert.throws(
      () => executeWorkPacket(f.packet, f.output, { run }),
      /WORK_EXCHANGE_RECEIPT_IDENTITY_MISMATCH/,
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('tampered receipt digest fails before worker execution', () => {
  const f = fixture();
  try {
    const value = JSON.parse(readFileSync(join(f.packet, 'receipt.json'), 'utf8'));
    value.authority_head = '3'.repeat(40);
    writeFileSync(join(f.packet, 'receipt.json'), `${JSON.stringify(value, null, 2)}\n`);

    let calls = 0;
    assert.throws(
      () =>
        executeWorkPacket(f.packet, f.output, {
          run: () => {
            calls += 1;
            return { status: 0, signal: null };
          },
        }),
      /WORK_EXCHANGE_RECEIPT_DIGEST_MISMATCH/,
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('hostile worker candidate is rejected and never published', () => {
  const f = fixture();
  try {
    const run: WorkExchangeRun = (_command, args) => {
      const hostile = JSON.parse(candidateBytes(f.assignment).toString('utf8'));
      hostile.run_id = 'other-run';
      writeFileSync(args[3]!, `${JSON.stringify(hostile, null, 2)}\n`);
      return { status: 0, signal: null };
    };

    assert.throws(
      () => executeWorkPacket(f.packet, f.output, { run }),
      /CANDIDATE_RUN_MISMATCH/,
    );
    assert.equal(readFileSync(join(f.packet, 'assignment.json')).equals(f.assignment), true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
