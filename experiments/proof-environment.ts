type Environment = Record<string, string | undefined>;

function required(env: Environment, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`GITHUB_PROOF_ENV_REQUIRED:${name}`);
  return value;
}

export function githubProofStateRef(proof: string, env: Environment = process.env): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(proof)) throw new Error('GITHUB_PROOF_NAME_INVALID');
  const runId = required(env, 'GITHUB_RUN_ID');
  const attempt = required(env, 'GITHUB_RUN_ATTEMPT');
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) throw new Error('GITHUB_PROOF_RUN_IDENTITY_INVALID');
  return `refs/overcenter/proofs/${proof}/${runId}/${attempt}`;
}
