import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

import { canonicalDigest } from '../../digest.ts';
import {
  GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED,
  GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA,
  GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA_VERSION,
} from '../../effect-adapter.ts';
import type {
  EffectAttemptBinding,
  TrustedEffectReleaseWitness,
  ValidatedEffectReleaseWitness,
} from '../../effect-release-witness.ts';
import { GITHUB_API_VERSION } from './contract.ts';

export interface GithubStatusMutationBody {
  state: 'error' | 'failure' | 'pending' | 'success';
  context: string;
  description: string;
}

export type GithubStatusPost = (
  token: string,
  path: string,
  body: GithubStatusMutationBody,
  attempt: EffectAttemptBinding,
) => Promise<{ status: number; body: string }>;

interface InternalGithubStatusNotDispatchedWitness {
  kind: typeof GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED;
  source: 'github-status/fresh-https';
  attempt: Readonly<EffectAttemptBinding>;
  observation: Readonly<{
    schema: typeof GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA;
    schema_version: typeof GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA_VERSION;
    transport: 'https';
    fresh_socket: true;
    secure_connected: false;
    method: 'POST';
    origin: string;
    path: string;
    body_sha256: string;
    error_code: string | null;
  }>;
}

const trustedWitnesses = new WeakSet<object>();

class GithubStatusNotDispatchedError extends Error {
  readonly witness: InternalGithubStatusNotDispatchedWitness;

  constructor(witness: InternalGithubStatusNotDispatchedWitness) {
    super(`GITHUB_STATUS_MUTATION_NOT_DISPATCHED:${witness.observation.error_code ?? 'UNKNOWN'}`);
    this.witness = witness;
  }
}

function transportErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function mintNotDispatchedWitness(
  attempt: EffectAttemptBinding,
  origin: string,
  path: string,
  body: GithubStatusMutationBody,
  errorCode: string | null,
): InternalGithubStatusNotDispatchedWitness {
  const witness: InternalGithubStatusNotDispatchedWitness = Object.freeze({
    kind: GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED,
    source: 'github-status/fresh-https',
    attempt: Object.freeze(structuredClone(attempt)),
    observation: Object.freeze({
      schema: GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA,
      schema_version: GITHUB_STATUS_NOT_DISPATCHED_OBSERVATION_SCHEMA_VERSION,
      transport: 'https',
      fresh_socket: true,
      secure_connected: false,
      method: 'POST',
      origin,
      path,
      body_sha256: canonicalDigest(body),
      error_code: errorCode,
    }),
  });
  trustedWitnesses.add(witness);
  return witness;
}

export function githubStatusNotDispatchedWitness(
  error: unknown,
): TrustedEffectReleaseWitness | null {
  if (!(error instanceof GithubStatusNotDispatchedError)) return null;
  return trustedWitnesses.has(error.witness)
    ? (error.witness as unknown as TrustedEffectReleaseWitness)
    : null;
}

export function consumeGithubStatusNotDispatchedWitness(
  value: unknown,
): ValidatedEffectReleaseWitness | null {
  if (!value || typeof value !== 'object' || !trustedWitnesses.delete(value as object)) {
    return null;
  }
  const witness = value as InternalGithubStatusNotDispatchedWitness;
  return {
    kind: witness.kind,
    source: witness.source,
    attempt: structuredClone(witness.attempt),
    observation: structuredClone(witness.observation),
  };
}

export function createGithubStatusPost({
  baseUrl = 'https://api.github.com',
  rejectUnauthorized = true,
  lookup,
}: {
  baseUrl?: string;
  rejectUnauthorized?: boolean;
  lookup?: LookupFunction;
} = {}): GithubStatusPost {
  const origin = new URL(baseUrl).origin;
  return async (token, path, body, attempt) => {
    if (!attempt) throw new Error('GITHUB_STATUS_EFFECT_ATTEMPT_BINDING_REQUIRED');
    return await new Promise((resolve, reject) => {
      let secureConnected = false;
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      const payload = JSON.stringify(body);
      const request = httpsRequest(
        new URL(path, baseUrl),
        {
          method: 'POST',
          agent: false,
          rejectUnauthorized,
          ...(lookup ? { lookup } : {}),
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': 'overcenter-research',
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          let responseBody = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            responseBody += chunk;
          });
          response.once('end', () =>
            finish(() => resolve({ status: response.statusCode ?? 0, body: responseBody })),
          );
          const uncertain = (error: unknown) =>
            finish(() =>
              reject(
                new Error(
                  `GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN:${
                    transportErrorCode(error) ?? 'RESPONSE_ABORTED'
                  }`,
                ),
              ),
            );
          response.once('aborted', () => uncertain(new Error('RESPONSE_ABORTED')));
          response.once('error', uncertain);
        },
      );
      request.once('socket', (socket) => {
        socket.once('secureConnect', () => {
          secureConnected = true;
        });
      });
      request.once('error', (error) =>
        finish(() =>
          reject(
            secureConnected
              ? new Error(
                  `GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN:${
                    transportErrorCode(error) ?? 'UNKNOWN'
                  }`,
                )
              : new GithubStatusNotDispatchedError(
                  mintNotDispatchedWitness(attempt, origin, path, body, transportErrorCode(error)),
                ),
          ),
        ),
      );
      request.end(payload);
    });
  };
}
