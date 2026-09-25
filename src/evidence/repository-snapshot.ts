import { execFileSync } from 'node:child_process';

export interface RepositorySnapshot {
  readonly repo: string;
  readonly revision: string;
  bytes(path: string): Buffer;
  optionalBytes(path: string): Buffer | null;
  blob(path: string): string;
}

function validateRevision(revision: string): string {
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error('REPOSITORY_SNAPSHOT_REVISION_INVALID');
  }
  return revision.toLowerCase();
}

export function repositorySnapshot(repo: string, revision: string): RepositorySnapshot {
  const sourceRevision = validateRevision(revision);

  const bytes = (path: string): Buffer =>
    execFileSync('git', ['-C', repo, 'show', `${sourceRevision}:${path}`], {
      maxBuffer: 16 * 1024 * 1024,
    });

  const optionalBytes = (path: string): Buffer | null => {
    const listed = execFileSync(
      'git',
      ['-C', repo, 'ls-tree', '--name-only', sourceRevision, '--', path],
      { encoding: 'utf8' },
    ).trim();
    if (listed === '') return null;
    if (listed !== path) throw new Error(`REPOSITORY_SNAPSHOT_PATH_AMBIGUOUS:${path}`);
    return bytes(path);
  };

  const blob = (path: string): string => {
    const raw = execFileSync('git', ['-C', repo, 'ls-tree', sourceRevision, '--', path], {
      encoding: 'utf8',
    }).trim();
    const match = raw.match(/^100(?:644|755) blob ([0-9a-f]{40})\t(.+)$/);
    if (!match || match[2] !== path) {
      throw new Error(`REPOSITORY_SNAPSHOT_BLOB_MISSING:${path}`);
    }
    return match[1]!;
  };

  return Object.freeze({
    repo,
    revision: sourceRevision,
    bytes,
    optionalBytes,
    blob,
  });
}
