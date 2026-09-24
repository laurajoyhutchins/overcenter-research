import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { AuthorityHead, AuthorityHeadRecord, ImmutableFactObjects } from '../../src/authority/store.ts';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
}

interface FactObject {
  schema: 'overcenter-immutable-fact-object/v1';
  files: Record<string, unknown>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function serialized(value: unknown): string {
  return JSON.stringify(canonical(value)) + '\n';
}

export class DirectoryFactObjects implements ImmutableFactObjects {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  put(files: Record<string, unknown>): string {
    const object: FactObject = {
      schema: 'overcenter-immutable-fact-object/v1',
      files,
    };
    const bytes = serialized(object);
    const id = createHash('sha256').update(bytes).digest('hex');
    const path = this.path(id);
    try {
      writeFileSync(path, bytes, { flag: 'wx' });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (readFileSync(path, 'utf8') !== bytes) throw new Error('FACT_OBJECT_HASH_COLLISION');
    }
    return id;
  }

  get(id: string): FactObject {
    let raw: string;
    try {
      raw = readFileSync(this.path(id), 'utf8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('FACT_OBJECT_MISSING:' + id);
      }
      throw error;
    }
    const object = JSON.parse(raw) as FactObject;
    if (object.schema !== 'overcenter-immutable-fact-object/v1') {
      throw new Error('FACT_OBJECT_SCHEMA_INVALID');
    }
    const digest = createHash('sha256').update(serialized(object)).digest('hex');
    if (digest !== id) throw new Error('FACT_OBJECT_DIGEST_MISMATCH');
    return object;
  }

  ids(): string[] {
    return readdirSync(this.root)
      .filter((name) => /^[0-9a-f]{64}$/.test(name))
      .sort();
  }

  removeForNegativeControl(id: string): void {
    unlinkSync(this.path(id));
  }

  private path(id: string): string {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('FACT_OBJECT_ID_INVALID');
    return join(this.root, id);
  }
}

export class GitAuthorityHead implements AuthorityHead {
  readonly repo: string;
  readonly ref: string;

  constructor(repo: string, ref: string) {
    this.repo = repo;
    this.ref = ref;
    this.git(['rev-parse', '--git-dir']);
  }

  head(): string | null {
    const result = this.git(['rev-parse', '-q', '--verify', this.ref], { allowFailure: true });
    return result.ok ? result.stdout.trim() : null;
  }

  advance(expectedHead: string | null, factId: string, message: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(factId)) throw new Error('FACT_OBJECT_ID_INVALID');
    const blob = this.git(['hash-object', '-w', '--stdin'], { input: factId + '\n' }).stdout.trim();
    const tree = this.git(['mktree'], {
      input: '100644 blob ' + blob + '\tfact-id\n',
    }).stdout.trim();
    const args = ['commit-tree', tree];
    if (expectedHead) args.push('-p', expectedHead);
    const next = this.git(args, {
      input: 'authority: ' + message + '\n',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Overcenter Authority Head',
        GIT_AUTHOR_EMAIL: 'authority-head@local',
        GIT_COMMITTER_NAME: 'Overcenter Authority Head',
        GIT_COMMITTER_EMAIL: 'authority-head@local',
      },
    }).stdout.trim();
    const expected = expectedHead ?? this.zeroObjectId();
    const updated = this.git(['update-ref', this.ref, next, expected], { allowFailure: true });
    return updated.ok ? next : null;
  }

  history(head: string): AuthorityHeadRecord[] {
    return this.git(['rev-list', '--reverse', head])
      .stdout.trim()
      .split(/\n+/)
      .filter(Boolean)
      .map((revision) => ({
        revision,
        parent: this.parent(revision),
        factId: this.factId(revision),
      }));
  }

  factId(revision: string): string {
    const value = this.git(['show', revision + ':fact-id']).stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('AUTHORITY_FACT_ID_INVALID');
    return value;
  }

  treePaths(revision: string): string[] {
    return this.git(['ls-tree', '--name-only', revision])
      .stdout.trim()
      .split(/\n+/)
      .filter(Boolean);
  }

  private parent(revision: string): string | null {
    const result = this.git(['rev-parse', revision + '^'], { allowFailure: true });
    return result.ok ? result.stdout.trim() : null;
  }

  private zeroObjectId(): string {
    return '0'.repeat(
      this.git(['rev-parse', '--show-object-format']).stdout.trim() === 'sha256' ? 64 : 40,
    );
  }

  private git(
    args: string[],
    {
      input = undefined,
      env = process.env,
      allowFailure = false,
    }: {
      input?: string;
      env?: Record<string, string | undefined>;
      allowFailure?: boolean;
    } = {},
  ): GitResult {
    try {
      const stdout = execFileSync('git', ['-C', this.repo, ...args], {
        input,
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true, stdout };
    } catch (error: unknown) {
      const failure = error as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };
      if (allowFailure) {
        return {
          ok: false,
          stdout: String(failure.stdout ?? ''),
          stderr: String(failure.stderr ?? ''),
        };
      }
      throw new Error(
        'git ' +
          args.join(' ') +
          ' failed: ' +
          String(failure.stderr ?? failure.message ?? '').trim(),
      );
    }
  }
}

