const FORBIDDEN_PROVIDER_CREDENTIALS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'OVERCENTER_GITHUB_TOKEN',
] as const;

export function minimalExecutionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TMP', 'TMPDIR', 'TEMP', 'USER']) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('LC_') && value !== undefined) env[name] = value;
  }
  return env;
}

export function assertNoProviderCredentials(env: NodeJS.ProcessEnv, prefix: string): void {
  for (const name of FORBIDDEN_PROVIDER_CREDENTIALS) {
    if (Object.hasOwn(env, name)) {
      throw new Error(`${prefix}_ENVIRONMENT_FORBIDDEN:${name}`);
    }
  }
}
