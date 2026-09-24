import { execFileSync } from 'node:child_process';

export function readJsonWithCurl(url: string, config: string, errorPrefix: string): unknown {
  try {
    const stdout = execFileSync(
      'curl',
      ['--silent', '--show-error', '--fail-with-body', '--config', '-', url],
      { input: config, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return JSON.parse(stdout);
  } catch (error: unknown) {
    const failure = error as {
      stderr?: string | Buffer;
      stdout?: string | Buffer;
      message?: string;
    };
    throw new Error(
      `${errorPrefix}: ${String(failure.stderr ?? failure.stdout ?? failure.message ?? '').trim()}`,
    );
  }
}
