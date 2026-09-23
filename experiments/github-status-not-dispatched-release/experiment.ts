import assert from 'node:assert/strict';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer, type Server } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OvercenterKernel } from '../../src/authority/kernel.ts';
import {
  effectAdapterCapabilities,
  GITHUB_COMMIT_STATUS_EFFECT,
  GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED,
} from '../../src/effect-adapter.ts';
import {
  createGithubStatusPost,
  performGithubCommitStatusEffect,
} from '../../src/providers/github/status-effect.ts';

const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDZUPsn3kwMJ6PT
i3/zvSeO+co3zPmSY/wyumruYbhZ/KAUQkqtnMPCNWjXFromaPRXimfJBQxQLpn8
zMGoT4nvgisHqRlifbAmYOSMwBY+DOemGatfELVCic2tr6kauh0MltoLmcqRuqKK
ukCZUm5bb9k82hxFBXlYv8edN18UCeDp/vuBgfHuCXlDjxE457ivUlCEOoPPZT6Y
Ulye3BQ/2mbnDjknY37mr7f6KXESHKyxTvwFd8+10MNNg56DqXzeeDTRvBDgePU9
C2z45ijO9khATbmxDKNEj+dYwAIVKADF2kdbhDI6AZx0Bu8EWiQVhQnanafCfZYp
R346sGgdAgMBAAECggEATG/u/11x2z6gIZrqJQXN4bzbk1f+Gq8feIpYbUOi78fr
WGTe1oUS1/8oQqtkS3lUJGxyx+KGK7fQgvpUTYq4hi1/TCD+5EU4Ta98BEPWLvok
CqjxvaznTKGi3iowrU10RUbUKAtulGaUoH4VlbhIR9ImE4DWO7LKtVwzbomY4DdZ
GWRg0TvcTrpXoWBolw0E0g/rpJ/a+p/PwsyOvQ0Av+KJpJv7AWdmVCoeJovD79CA
iIAF2TlEiaqy7Ey5n98nZ5mwDFZvxnxSehhlHAdAxIyUSI8HLq52VHBg+268+sVJ
zeq4hBaX+LjfnV5bUJjWswBagCxWRjeRWxCAwCLjowKBgQD5zJ/Bt4QGnLqzjFFW
x0lFDGVpsdZi1xfa9ILnc7/DYkhSj8lcwTSyvZHBv6Rm9PC3ei7/gzg408ylnqGC
Q5MKzi4Bm05wthXpu5El7TSBt8KWnKdkzR+grLNbqgY88rZvkiat1CdmVghwTrGx
Llg3HAbpBd6wwo0yqCA/ddQRRwKBgQDetfDF4nBVeB1McMgK/558h/VZx9dCUfcm
c9jybUk3yOqoO2ufpymbzmbcX321xCq0YvU/jlA0uh9Lu33xzFkQllVBBaiF1F+J
N1aaqnjHHaDRrs6vwmKpknNmJGoa8Q3fJlBC24OCgckA/KXmNT9GbRhzgZKWa2o3
SUWLEXiNewKBgQCEJMA6bQdVrCGEC+2Xd3MGKOmZAS/FN73x4TlCkVPXWy2hJ1lB
TR/AklIB6Yxhvp98oBEur87VGQ4AaytLSs4FgE6MIQlczKZI8CV3p8UH/hrdK9/N
jkl16QY0rnwAT/E8klcNy9ZP56EtMCQF89tMw/HP4YANh83EB3aPu5hEzwKBgQCO
ksUPuZWWca23+N9ngxsPt+4Oyst4Toa9HB6/m8zqpHnstxWAAIC3mNvqqksM6Qc5
sbw1MsMP7jMIxX+sItjFsKflV1z6R+ndKwsLOqTVO5dvhMwWYofM7M9pjVhL5ROv
TpTFKEg5bSKjuhnulRnr2P11PHb+SseVmxelHsshLwKBgGC4Nz8sHxKgWLkV/v2B
ZjmrR42ziLpofNOzwQATuMId7La0+qmd/4zLEbS/guzFLnMsxKtPumCOhoFZ29w7
wY4MArg77xwH/sP+zgtUQx5uNzV/FH1mAA9blp8nx0MQoLOYxGWTKJEIsH7HRcSY
T5fON6xrhaomXfgNi2x8B4EN
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUE2nGRxty7azbIVQcHEXW4A8AA0EwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkyMzA1NTczOFoXDTM2MDky
MDA1NTczOFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA2VD7J95MDCej04t/870njvnKN8z5kmP8Mrpq7mG4Wfyg
FEJKrZzDwjVo1xa6Jmj0V4pnyQUMUC6Z/MzBqE+J74IrB6kZYn2wJmDkjMAWPgzn
phmrXxC1QonNra+pGrodDJbaC5nKkbqiirpAmVJuW2/ZPNocRQV5WL/HnTdfFAng
6f77gYHx7gl5Q48ROOe4r1JQhDqDz2U+mFJcntwUP9pm5w45J2N+5q+3+ilxEhys
sU78BXfPtdDDTYOeg6l83ng00bwQ4Hj1PQts+OYozvZIQE25sQyjRI/nWMACFSgA
xdpHW4QyOgGcdAbvBFokFYUJ2p2nwn2WKUd+OrBoHQIDAQABo1MwUTAdBgNVHQ4E
FgQU9+jg3avAkItjDUJqR7SJnJ10DqgwHwYDVR0jBBgwFoAU9+jg3avAkItjDUJq
R7SJnJ10DqgwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAnE0b
dQl/jGKbilTwEsOQKDyENDKY49cKhAGGDXxDQIfOEvfoC8DMGxCJ37dEPZnHBOV0
P23fmqVPQQlUTsDvhRn4dS8OADwfZA+VH7O90p+CuO1Tfy2aC+bf1CUBH2bfKu3b
0HLdew+bqLMLcrtuclld+RWc9ym1ioZDHm7fZDOOGQ8FuYKmJtSisvEKHjT2L9EL
sG3crG4X+DxEDyr07XSIRuYRhcvEZ4EYK1Zhlx+mdi1ZRg2zueST8FtJRHwKJiNC
OpuXda4j67y60m0rwSkg5TjdDOv4rHKM5oSqWyo9n+BYhUX2LOvPPQcN0rHo05mI
HG8xElW6gaNx6HGDrw==
-----END CERTIFICATE-----`;
const COMMIT = 'a'.repeat(40);

function repository() {
  return {
    id: 42,
    node_id: 'R_42',
    full_name: 'acme/widget',
    name: 'widget',
    owner: { login: 'acme' },
  };
}

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('INVALID_LISTEN_ADDRESS');
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function define(kernel: OvercenterKernel) {
  kernel.initialize();
  kernel.define({
    id: 'status-proof',
    packet: { effect_contract: GITHUB_COMMIT_STATUS_EFFECT },
    postcondition: {
      verifier: 'github-commit-status/v2',
      provider: 'github',
      repository_id: 42,
      repository_full_name: 'acme/widget',
      commit_sha: COMMIT,
      context: 'overcenter/proof',
      expected_state: 'success',
    },
  });
  const work = kernel.deriveReadyWork();
  assert.ok(work);
  return kernel.claim(work.id, work.revision);
}

function kernelAt(root: string) {
  return new OvercenterKernel(join(root, 'overcenter.sqlite'));
}

const capabilities = effectAdapterCapabilities(GITHUB_COMMIT_STATUS_EFFECT);
assert.ok(capabilities);
assert.equal(capabilities.replay.kind, 'forbidden');
assert.equal(capabilities.reservation_release.kind, 'not-dispatched');
assert.deepEqual(
  capabilities.reservation_release.kind === 'not-dispatched'
    ? capabilities.reservation_release.evidence_kinds
    : [],
  [GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED],
);

const results: Record<string, unknown> = {};

// Case 1: handshake failure proves no HTTP mutation crossed the TLS boundary.
// The reservation release and READY receipt must be one durable commit, and retry
// must become a new run rather than reopening the old execution.
{
  const root = mkdtempSync(join(tmpdir(), 'status-release-safe-'));
  const kernel = kernelAt(root);
  let peerTlsBytes = 0;
  const reset = createTcpServer((socket) => {
    socket.once('data', (chunk) => {
      peerTlsBytes += chunk.length;
      socket.destroy();
    });
  });
  const port = await listen(reset);
  try {
    const first = define(kernel);
    const post = createGithubStatusPost({
      baseUrl: `https://127.0.0.1:${port}`,
      rejectUnauthorized: false,
    });
    await assert.rejects(
      performGithubCommitStatusEffect(kernel, first, {
        token: 'token',
        get: () => repository(),
        post,
      }),
      /GITHUB_STATUS_MUTATION_NOT_DISPATCHED/,
    );
    assert.ok(peerTlsBytes > 0);
    assert.equal(kernel.hasUnresolvedEffect(first.id), false);
    assert.equal(kernel.inspect()[0].status, 'READY');
    const receipts = kernel.receipts(first.id);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.kind, 'effect-not-dispatched');
    assert.equal(receipts[0]?.disposition, 'READY');

    const retryWork = kernel.deriveReadyWork();
    assert.ok(retryWork);
    const second = kernel.claim(retryWork.id, retryWork.revision);
    assert.notEqual(second.id, first.id);
    assert.equal(second.execution_generation, 1);

    let received = '';
    const success = createHttpsServer({ key: KEY, cert: CERT }, (request, response) => {
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        received += chunk;
      });
      request.on('end', () => {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    const successPort = await listen(success);
    try {
      await performGithubCommitStatusEffect(kernel, second, {
        token: 'token',
        get: () => repository(),
        post: createGithubStatusPost({
          baseUrl: `https://127.0.0.1:${successPort}`,
          rejectUnauthorized: false,
        }),
      });
      assert.ok(received.includes('"state":"success"'));
      assert.equal(kernel.hasUnresolvedEffect(second.id), true);
    } finally {
      await close(success);
    }

    results.safe_release = {
      peer_tls_bytes: peerTlsBytes,
      old_run_status: 'READY',
      old_run_reservation_released: true,
      retry_is_new_run: second.id !== first.id,
      successful_retry_reserved_until_readback: kernel.hasUnresolvedEffect(second.id),
    };
  } finally {
    await close(reset);
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// Case 2: after secureConnect, peer-observed HTTP bytes make the outcome UNKNOWN.
// The reservation must survive and recovery must not expose READY work.
{
  const root = mkdtempSync(join(tmpdir(), 'status-release-unknown-'));
  const kernel = kernelAt(root);
  let peerApplicationBytes = 0;
  const reset = createTlsServer({ key: KEY, cert: CERT }, (socket) => {
    socket.once('data', (chunk) => {
      peerApplicationBytes += chunk.length;
      socket.destroy();
    });
  });
  const port = await listen(reset);
  try {
    const run = define(kernel);
    await assert.rejects(
      performGithubCommitStatusEffect(kernel, run, {
        token: 'token',
        get: () => repository(),
        post: createGithubStatusPost({
          baseUrl: `https://127.0.0.1:${port}`,
          rejectUnauthorized: false,
        }),
      }),
      /GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN/,
    );
    assert.ok(peerApplicationBytes > 0);
    assert.equal(kernel.hasUnresolvedEffect(run.id), true);
    const interrupted = kernel.recoverInterrupted(run, { source: 'experiment' });
    assert.equal(interrupted.disposition, 'RECOVERY_REQUIRED');
    assert.equal(kernel.inspect()[0].status, 'RECOVERY_REQUIRED');
    assert.equal(kernel.deriveReadyWork(), null);

    const recovery = kernel.acquireExecution(run.id);
    let posts = 0;
    await assert.rejects(
      performGithubCommitStatusEffect(kernel, recovery, {
        token: 'token',
        get: () => repository(),
        post: async () => {
          posts += 1;
          return { status: 201, body: '{}' };
        },
      }),
      /RUN_NOT_EXECUTING/,
    );
    assert.equal(posts, 0);
    assert.equal(kernel.hasUnresolvedEffect(run.id), true);

    results.unknown_preserved = {
      peer_application_bytes: peerApplicationBytes,
      final_status: kernel.inspect()[0]?.status,
      mutation_replay_posts: posts,
      unresolved_effect: kernel.hasUnresolvedEffect(run.id),
    };
  } finally {
    await close(reset);
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// Case 3: HTTP failure is not a dispatch witness and cannot release the reservation.
{
  const root = mkdtempSync(join(tmpdir(), 'status-release-http-'));
  const kernel = kernelAt(root);
  let bodies = 0;
  const server = createHttpsServer({ key: KEY, cert: CERT }, (request, response) => {
    request.on('data', (chunk) => {
      bodies += chunk.length;
    });
    request.on('end', () => {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('bad gateway');
    });
  });
  const port = await listen(server);
  try {
    const run = define(kernel);
    await assert.rejects(
      performGithubCommitStatusEffect(kernel, run, {
        token: 'token',
        get: () => repository(),
        post: createGithubStatusPost({
          baseUrl: `https://127.0.0.1:${port}`,
          rejectUnauthorized: false,
        }),
      }),
      /GITHUB_STATUS_MUTATION_FAILED:502/,
    );
    assert.ok(bodies > 0);
    assert.equal(kernel.hasUnresolvedEffect(run.id), true);
    assert.equal(kernel.inspect()[0]?.status, 'EXECUTING');
    results.http_502 = {
      peer_application_bytes: bodies,
      unresolved_effect: true,
    };
  } finally {
    await close(server);
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// Case 4: neither the exact admitted token without provenance nor stale authority can clear a reservation.
{
  const root = mkdtempSync(join(tmpdir(), 'status-release-adversary-'));
  const kernel = kernelAt(root);
  try {
    const run = define(kernel);
    const authority = kernel.authorizeEffect(
      run,
      GITHUB_COMMIT_STATUS_EFFECT,
      'github-commit-status/v2',
    );
    kernel.beginEffect(run);
    assert.throws(
      () => kernel.releaseEffectReservation(authority, GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED),
      /EFFECT_RELEASE_EVIDENCE_PROVENANCE_INVALID/,
    );
    assert.equal(kernel.hasUnresolvedEffect(run.id), true);

    kernel.acquireExecution(run.id);
    assert.throws(
      () => kernel.releaseEffectReservation(authority, GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED),
      /STALE_EXECUTION_GENERATION/,
    );
    assert.equal(kernel.hasUnresolvedEffect(run.id), true);

    results.adversaries = {
      forged_evidence: 'BLOCKED',
      stale_authority: 'BLOCKED',
      unresolved_effect: true,
    };
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(
  JSON.stringify(
    {
      experiment: 'github-status-not-dispatched-release',
      result: 'SUPPORTED_IF_ALL_ASSERTIONS_PASS',
      ...results,
      safety_boundary: {
        provider_replay_capability: 'forbidden',
        reservation_release_capability: 'trusted-not-dispatched-only',
      },
    },
    null,
    2,
  ),
);
