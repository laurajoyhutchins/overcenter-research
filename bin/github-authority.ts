import {
  executeGithubAuthorityCommand,
  githubAuthorityExitCode,
  githubAuthorityUsage,
  parseGithubAuthorityCommand,
} from '../src/providers/github/authority-command.ts';

const token=process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN_REQUIRED');
  process.exitCode=3;
} else {
  try {
    const command=parseGithubAuthorityCommand(process.argv.slice(2));
    const result=executeGithubAuthorityCommand(token,command);
    console.log(JSON.stringify(result,null,2));
    process.exitCode=githubAuthorityExitCode(result.state);
  } catch (error:unknown) {
    console.error(error instanceof Error?error.message:String(error));
    console.error(githubAuthorityUsage());
    process.exitCode=64;
  }
}
