import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

import type { KernelCore } from '../../authority/engine.ts';
import type { ExecutionPermit } from '../../model.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED,
} from '../../effect-adapter.ts';
import { GITHUB_API_VERSION } from './contract.ts';
import { observeCertifiedGithubRepository } from './certified-repository.ts';
import { githubGetAsync, runGithubReadObserverAsync, type GithubJsonGetAsync } from './rest.ts';

export { GITHUB_COMMIT_STATUS_EFFECT } from '../../effect-adapter.ts';

export interface GithubStatusMutationBody {
  state: 'error' | 'failure' | 'pending' | 'success';
  context: string;
  description: string;
}

export type GithubStatusPost = (
  token: string,
  path: string,
  body: GithubStatusMutationBody,
) => Promise<{ status: number; body: string }>;

class GithubStatusNotDispatchedError extends Error {
  readonly errorCode: string | null;
  constructor(errorCode: string | null) {
    super(`GITHUB_STATUS_MUTATION_NOT_DISPATCHED:${errorCode ?? 'UNKNOWN'}`);
    this.errorCode = errorCode;
  }
}
function transportErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
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
  return async (token, path, body) =>
    await new Promise((resolve, reject) => {
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
                  `GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN:${transportErrorCode(error) ?? 'RESPONSE_ABORTED'}`,
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
                  `GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN:${transportErrorCode(error) ?? 'UNKNOWN'}`,
                )
              : new GithubStatusNotDispatchedError(transportErrorCode(error)),
          ),
        ),
      );
      request.end(payload);
    });
}
const githubPost = createGithubStatusPost();

export async function performGithubCommitStatusEffect(
  kernel: KernelCore,
  permit: ExecutionPermit,
  {
    token,
    get = githubGetAsync,
    post = githubPost,
    clock = () => new Date().toISOString(),
  }: {
    token: string;
    get?: GithubJsonGetAsync;
    post?: GithubStatusPost;
    clock?: () => string;
  },
): Promise<{
  repository_id: number;
  repository_full_name: string;
  commit_sha: string;
  context: string;
  state: 'error' | 'failure' | 'pending' | 'success';
}> {
  if (!token) throw new Error('GITHUB_TOKEN_UNAVAILABLE');

  const authority = kernel.authorizeEffect(permit, GITHUB_COMMIT_STATUS_EFFECT);
  const p = authority.postcondition;
  const repository = await runGithubReadObserverAsync(
    token,
    (syncGet) =>
      observeCertifiedGithubRepository(token, {
        repositoryId: p.repository_id,
        repositoryFullName: p.repository_full_name,
        get: syncGet,
        clock,
        observerId: 'github-commit-status-effect/v1',
      }),
    get,
  );
  const { owner, repo, full_name } = repository.fact.object;
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(p.commit_sha)}`;
  const body: GithubStatusMutationBody = {
    state: p.expected_state,
    context: p.context,
    description: 'Overcenter trusted effect broker',
  };

  try {
    return await kernel.performEffect(authority, async () => {
      const response = await post(token, path, body);
      if (response.status !== 201) {
        throw new Error(`GITHUB_STATUS_MUTATION_FAILED:${response.status}:${response.body}`);
      }
      return {
        repository_id: p.repository_id,
        repository_full_name: full_name,
        commit_sha: p.commit_sha,
        context: p.context,
        state: p.expected_state,
      };
    });
  } catch (error: unknown) {
    if (error instanceof GithubStatusNotDispatchedError) {
      kernel.releaseEffectReservation(authority, GITHUB_STATUS_FRESH_HTTPS_NOT_DISPATCHED, {
        source: 'github-status/fresh-https',
        transport_error_code: error.errorCode,
      });
    }
    throw error;
  }
}
