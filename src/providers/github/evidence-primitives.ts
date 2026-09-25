import { githubGet, type GithubJsonGet } from './rest.ts';

export interface GithubEvidenceFile {
  bytes: Buffer;
  blob: string;
}

export interface GithubWorkflowArtifactEvidence {
  workflow_run_id: number;
  revision: string;
  artifact_digest: string;
}

const data = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function githubRepositoryPath(repositoryFullName: string, suffix = ''): string {
  const [owner, repo, ...extra] = repositoryFullName.split('/');
  if (!owner || !repo || extra.length > 0) {
    throw new Error('GITHUB_EVIDENCE_REPOSITORY_INVALID');
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

export function readGithubEvidenceFile(
  token: string,
  {
    repositoryFullName,
    path,
    ref,
    get = githubGet,
  }: {
    repositoryFullName: string;
    path: string;
    ref: string;
    get?: GithubJsonGet;
  },
): GithubEvidenceFile {
  const encodedPath = path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const raw = get(
    token,
    githubRepositoryPath(
      repositoryFullName,
      `/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    ),
  );
  if (
    !data(raw) ||
    raw.type !== 'file' ||
    typeof raw.sha !== 'string' ||
    raw.encoding !== 'base64' ||
    typeof raw.content !== 'string'
  ) {
    throw new Error(`GITHUB_EVIDENCE_FILE_INVALID:${path}`);
  }
  return {
    bytes: Buffer.from(raw.content.replace(/\s/g, ''), 'base64'),
    blob: raw.sha.toLowerCase(),
  };
}

export function verifyGithubRepositoryIdentity(
  token: string,
  {
    repositoryId,
    repositoryFullName,
    get = githubGet,
  }: {
    repositoryId: number;
    repositoryFullName: string;
    get?: GithubJsonGet;
  },
): void {
  const repository = get(token, githubRepositoryPath(repositoryFullName));
  if (
    !data(repository) ||
    repository.id !== repositoryId ||
    typeof repository.full_name !== 'string' ||
    repository.full_name.toLowerCase() !== repositoryFullName.toLowerCase()
  ) {
    throw new Error('GITHUB_EVIDENCE_REPOSITORY_IDENTITY_MISMATCH');
  }
}

export function verifyGithubWorkflowArtifact(
  token: string,
  {
    repositoryFullName,
    workflowRunId,
    revision,
    workflowPath,
    jobName,
    artifactName,
    artifactDigest,
    get = githubGet,
  }: {
    repositoryFullName: string;
    workflowRunId: number;
    revision: string;
    workflowPath: string;
    jobName: string;
    artifactName: string;
    artifactDigest: string;
    get?: GithubJsonGet;
  },
): GithubWorkflowArtifactEvidence {
  const run = get(
    token,
    githubRepositoryPath(repositoryFullName, `/actions/runs/${workflowRunId}`),
  );
  if (
    !data(run) ||
    run.path !== workflowPath ||
    typeof run.head_sha !== 'string' ||
    run.head_sha.toLowerCase() !== revision.toLowerCase() ||
    run.conclusion !== 'success'
  ) {
    throw new Error(`GITHUB_EVIDENCE_WORKFLOW_RUN_INVALID:${workflowRunId}`);
  }

  const jobs = get(
    token,
    githubRepositoryPath(repositoryFullName, `/actions/runs/${workflowRunId}/jobs?per_page=100`),
  );
  const job =
    data(jobs) && Array.isArray(jobs.jobs)
      ? jobs.jobs.find((candidate) => data(candidate) && candidate.name === jobName)
      : null;
  if (!data(job) || job.conclusion !== 'success') {
    throw new Error(`GITHUB_EVIDENCE_WORKFLOW_JOB_INVALID:${workflowRunId}:${jobName}`);
  }

  const artifacts = get(
    token,
    githubRepositoryPath(
      repositoryFullName,
      `/actions/runs/${workflowRunId}/artifacts?per_page=100`,
    ),
  );
  const artifact =
    data(artifacts) && Array.isArray(artifacts.artifacts)
      ? artifacts.artifacts.find(
          (candidate) =>
            data(candidate) &&
            candidate.name === artifactName &&
            candidate.expired === false &&
            typeof candidate.digest === 'string',
        )
      : null;
  if (!data(artifact) || String(artifact.digest).toLowerCase() !== artifactDigest.toLowerCase()) {
    throw new Error(`GITHUB_EVIDENCE_ARTIFACT_INVALID:${workflowRunId}:${artifactName}`);
  }

  return {
    workflow_run_id: workflowRunId,
    revision: revision.toLowerCase(),
    artifact_digest: artifactDigest.toLowerCase(),
  };
}
