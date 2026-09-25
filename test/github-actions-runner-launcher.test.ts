import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  launchGithubActionsJitRunner,
  type GithubActionsRunnerSpawn,
} from '../src/execution/actions-runner/launcher.ts';
import {
  executeWorkPacketTransport,
  type WorkPacketTransportRequest,
  type WorkPacketTransportSpawn,
} from '../src/execution/actions-runner/work-packet-transport.ts';
import { sha256 } from '../src/digest.ts';
import type { GithubActionsRunnerConnection } from '../src/providers/github/actions-runner-backend.ts';

function runnerConnection(config = 'jit-secret'): GithubActionsRunnerConnection {
  return {
    lease_id: 'sandbox-slot',
    runner_id: 91,
    runner_name: 'overcenter-proof',
    repository_id: 42,
    repository_full_name: 'acme/widget',
    labels: ['overcenter', 'self-hosted'],
    encoded_jit_config: config,
    encoded_jit_config_sha256: sha256(config),
  };
}

test('JIT launcher starts one clean runner without inheriting provider credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-actions-runner-'));
  try {
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n');
    mkdirSync(join(root, '_work'));

    let calls = 0;
    const spawnProcess: GithubActionsRunnerSpawn = async (command, args, options) => {
      calls += 1;
      assert.equal(command, join(root, 'run.sh'));
      assert.deepEqual(args, ['--jitconfig', 'jit-secret']);
      assert.equal(options.cwd, root);
      assert.equal(options.env.PATH, '/usr/bin:/bin');
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.OVERCENTER_GITHUB_TOKEN, undefined);
      return { code: 0, signal: null };
    };

    const result = await launchGithubActionsJitRunner(runnerConnection(), {
      runnerRoot: root,
      spawnProcess,
      processEnv: {
        PATH: '/usr/bin:/bin',
        HOME: '/tmp/home',
        GITHUB_TOKEN: 'must-not-cross',
        GH_TOKEN: 'must-not-cross',
        OVERCENTER_GITHUB_TOKEN: 'must-not-cross',
      },
    });

    assert.equal(calls, 1);
    assert.deepEqual(result, {
      runner_id: 91,
      runner_name: 'overcenter-proof',
      exit_code: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('JIT launcher rejects dirty work roots and altered config bytes before spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-actions-runner-dirty-'));
  try {
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n');
    mkdirSync(join(root, '_work'));
    writeFileSync(join(root, '_work', 'leftover'), 'state');

    let calls = 0;
    const spawnProcess: GithubActionsRunnerSpawn = async () => {
      calls += 1;
      return { code: 0, signal: null };
    };
    await assert.rejects(
      launchGithubActionsJitRunner(runnerConnection(), { runnerRoot: root, spawnProcess }),
      /GITHUB_ACTIONS_RUNNER_WORK_FOLDER_NOT_CLEAN/,
    );
    assert.equal(calls, 0);

    rmSync(join(root, '_work'), { recursive: true, force: true });
    const changed = runnerConnection();
    changed.encoded_jit_config = 'different';
    await assert.rejects(
      launchGithubActionsJitRunner(changed, { runnerRoot: root, spawnProcess }),
      /GITHUB_ACTIONS_RUNNER_JIT_CONFIG_DIGEST_MISMATCH/,
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

function packetFixture(root: string): {
  packetRoot: string;
  output: string;
  executable: string;
  assignment: Buffer;
} {
  const packetRoot = join(root, 'packet');
  mkdirSync(packetRoot);
  const assignment = assignmentBytes();
  writeFileSync(join(packetRoot, 'assignment.json'), assignment);
  writeFileSync(join(packetRoot, 'overcenter'), 'native-client-bytes');
  writeFileSync(
    join(packetRoot, 'receipt.json'),
    `${JSON.stringify(
      {
        state: 'AGENT_EXECUTION_REQUIRED',
        obligation_id: 'proof',
        run_id: 'run-1',
        claimed_revision: 'claim-1',
        assignment_sha256: assignmentSha256(assignment),
      },
      null,
      2,
    )}\n`,
  );
  const executable = join(root, 'transport');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  return {
    packetRoot,
    output: join(root, 'candidate.json'),
    executable,
    assignment,
  };
}

test('work packet transport exposes exact packet bytes but no GitHub credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-work-packet-'));
  try {
    const fixture = packetFixture(root);
    let calls = 0;
    const spawnProcess: WorkPacketTransportSpawn = async (command, args, options) => {
      calls += 1;
      assert.equal(command, fixture.executable);
      assert.equal(options.env.PATH, '/usr/bin:/bin');
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.env.ACTIONS_RUNTIME_TOKEN, undefined);
      assert.equal(args.length, 2);
      const request = JSON.parse(
        readFileSync(args[0]!, 'utf8'),
      ) as WorkPacketTransportRequest;
      assert.equal(request.schema, 'overcenter-work-packet-transport/v1');
      assert.equal(request.assignment_sha256, assignmentSha256(fixture.assignment));
      assert.equal(request.obligation_id, 'proof');
      assert.equal(request.run_id, 'run-1');
      assert.equal(request.source_revision, '1'.repeat(40));
      assert.equal(request.assignment_path, join(fixture.packetRoot, 'assignment.json'));
      assert.equal(request.worker_client_path, join(fixture.packetRoot, 'overcenter'));

      const output = Buffer.from('done\n');
      writeFileSync(
        args[1]!,
        `${JSON.stringify(
          {
            schema: 'overcenter-agent-candidate/v1',
            assignment_sha256: request.assignment_sha256,
            obligation_id: request.obligation_id,
            run_id: request.run_id,
            claimed_revision: 'claim-1',
            output_path: 'result.txt',
            output_sha256: sha256(output),
            output_base64: output.toString('base64'),
          },
          null,
          2,
        )}\n`,
      );
      return { code: 0, signal: null };
    };

    const candidate = await executeWorkPacketTransport(
      {
        packetRoot: fixture.packetRoot,
        transport: fixture.executable,
        candidateOutputPath: fixture.output,
      },
      {
        spawnProcess,
        processEnv: {
          PATH: '/usr/bin:/bin',
          GITHUB_TOKEN: 'must-not-cross',
          ACTIONS_RUNTIME_TOKEN: 'must-not-cross',
        },
      },
    );

    assert.equal(calls, 1);
    assert.equal(candidate.run_id, 'run-1');
    assert.equal(candidate.output_sha256, sha256('done\n'));
    assert.equal(JSON.parse(readFileSync(fixture.output, 'utf8')).run_id, 'run-1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipt mismatch and hostile candidate fail closed around the transport', async () => {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-work-packet-hostile-'));
  try {
    const fixture = packetFixture(root);
    const receiptPath = join(fixture.packetRoot, 'receipt.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    receipt.run_id = 'other-run';
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    let calls = 0;
    const spawnProcess: WorkPacketTransportSpawn = async (_command, args) => {
      calls += 1;
      writeFileSync(args[1]!, '{}\n');
      return { code: 0, signal: null };
    };
    await assert.rejects(
      executeWorkPacketTransport(
        {
          packetRoot: fixture.packetRoot,
          transport: fixture.executable,
          candidateOutputPath: fixture.output,
        },
        { spawnProcess },
      ),
      /WORK_PACKET_TRANSPORT_RECEIPT_IDENTITY_MISMATCH/,
    );
    assert.equal(calls, 0);

    writeFileSync(
      receiptPath,
      `${JSON.stringify(
        {
          state: 'AGENT_EXECUTION_REQUIRED',
          obligation_id: 'proof',
          run_id: 'run-1',
          claimed_revision: 'claim-1',
          assignment_sha256: assignmentSha256(fixture.assignment),
        },
        null,
        2,
      )}\n`,
    );
    await assert.rejects(
      executeWorkPacketTransport(
        {
          packetRoot: fixture.packetRoot,
          transport: fixture.executable,
          candidateOutputPath: fixture.output,
        },
        { spawnProcess },
      ),
      /CANDIDATE_SHAPE_INVALID/,
    );
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
