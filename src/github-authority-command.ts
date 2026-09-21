import {GITHUB_AUTHORITY_SCHEMAS} from './generated/schema-identifiers.ts';
import type {
  CertifiedGithubPullRequestIdentityResult,
  GithubPullRequestExpectedIdentity,
} from './providers/github-certified-pr.ts';
import {
  observeCertifiedGithubPullRequestIdentity,
} from './providers/github-certified-pr.ts';
import type {
  CertifiedGithubRefFenceResult,
} from './providers/github-certified-ref.ts';
import {
  observeCertifiedGithubRefFence,
} from './providers/github-certified-ref.ts';
import type { GithubJsonGet } from './providers/github-rest.ts';

export type GithubAuthorityState='CURRENT'|'STALE'|'INDETERMINATE';

export type GithubAuthorityCommand =
  | {
      kind:'ref';
      repository_id:number;
      repository_full_name:string;
      ref:string;
      expected_sha:string;
    }
  | {
      kind:'pr';
      repository_id:number;
      repository_full_name:string;
      pull_number:number;
      expected:GithubPullRequestExpectedIdentity;
    };

export type GithubAuthorityCommandResult =
  | {
      schema:typeof GITHUB_AUTHORITY_SCHEMAS.command;
      command:'ref';
      state:GithubAuthorityState;
      result:CertifiedGithubRefFenceResult;
    }
  | {
      schema:typeof GITHUB_AUTHORITY_SCHEMAS.command;
      command:'pr';
      state:GithubAuthorityState;
      result:CertifiedGithubPullRequestIdentityResult;
    };

function parseFlags(argv:string[]):Record<string,string> {
  if (argv.length%2!==0) throw new Error('GITHUB_AUTHORITY_ARGUMENT_VALUE_REQUIRED');
  const flags:Record<string,string>={};
  for (let index=0;index<argv.length;index+=2) {
    const name=argv[index];
    const value=argv[index+1];
    if (!name.startsWith('--') || name.length<=2) {
      throw new Error(`GITHUB_AUTHORITY_FLAG_INVALID:${name}`);
    }
    const key=name.slice(2);
    if (Object.hasOwn(flags,key)) {
      throw new Error(`GITHUB_AUTHORITY_FLAG_DUPLICATE:${name}`);
    }
    flags[key]=value;
  }
  return flags;
}

function only(flags:Record<string,string>,allowed:string[]):void {
  const allowedSet=new Set(allowed);
  for (const key of Object.keys(flags)) {
    if (!allowedSet.has(key)) throw new Error(`GITHUB_AUTHORITY_FLAG_UNKNOWN:--${key}`);
  }
}

function required(flags:Record<string,string>,name:string):string {
  const value=flags[name];
  if (!value) throw new Error(`GITHUB_AUTHORITY_FLAG_REQUIRED:--${name}`);
  return value;
}

function positiveInteger(value:string,name:string):number {
  const parsed=Number(value);
  if (!Number.isSafeInteger(parsed) || parsed<=0) {
    throw new Error(`GITHUB_AUTHORITY_INTEGER_INVALID:--${name}`);
  }
  return parsed;
}

export function parseGithubAuthorityCommand(argv:string[]):GithubAuthorityCommand {
  const [kind,...rest]=argv;
  if (kind!=='ref' && kind!=='pr') {
    throw new Error('GITHUB_AUTHORITY_COMMAND_REQUIRED:ref|pr');
  }
  const flags=parseFlags(rest);

  if (kind==='ref') {
    only(flags,['repository-id','repository','ref','expected-sha']);
    return {
      kind:'ref',
      repository_id:positiveInteger(required(flags,'repository-id'),'repository-id'),
      repository_full_name:required(flags,'repository'),
      ref:required(flags,'ref'),
      expected_sha:required(flags,'expected-sha'),
    };
  }

  only(flags,[
    'repository-id',
    'repository',
    'pull-number',
    'node-id',
    'state',
    'head-sha',
    'base-ref',
    'base-sha',
  ]);
  return {
    kind:'pr',
    repository_id:positiveInteger(required(flags,'repository-id'),'repository-id'),
    repository_full_name:required(flags,'repository'),
    pull_number:positiveInteger(required(flags,'pull-number'),'pull-number'),
    expected:{
      node_id:required(flags,'node-id'),
      state:required(flags,'state'),
      head_sha:required(flags,'head-sha'),
      base_ref:required(flags,'base-ref'),
      base_sha:required(flags,'base-sha'),
    },
  };
}

export function executeGithubAuthorityCommand(
  token:string,
  command:GithubAuthorityCommand,
  {
    get,
    clock,
  }:{
    get?:GithubJsonGet;
    clock?:()=>string;
  }={},
):GithubAuthorityCommandResult {
  if (command.kind==='ref') {
    const result=observeCertifiedGithubRefFence(token,{
      repositoryId:command.repository_id,
      repositoryFullName:command.repository_full_name,
      ref:command.ref,
      expectedSha:command.expected_sha,
      ...(get?{get}:{}),
      ...(clock?{clock}:{}),
    });
    return {
      schema:GITHUB_AUTHORITY_SCHEMAS.command,
      command:'ref',
      state:result.state,
      result,
    };
  }

  const result=observeCertifiedGithubPullRequestIdentity(token,{
    repositoryId:command.repository_id,
    repositoryFullName:command.repository_full_name,
    pullNumber:command.pull_number,
    expected:command.expected,
    ...(get?{get}:{}),
    ...(clock?{clock}:{}),
  });
  return {
    schema:GITHUB_AUTHORITY_SCHEMAS.command,
    command:'pr',
    state:result.state,
    result,
  };
}

export function githubAuthorityExitCode(state:GithubAuthorityState):0|2|3 {
  if (state==='CURRENT') return 0;
  if (state==='STALE') return 2;
  return 3;
}

export function githubAuthorityUsage():string {
  return [
    'github:authority ref',
    '  --repository-id <numeric-id>',
    '  --repository <owner/repo>',
    '  --ref <heads/name|refs/heads/name>',
    '  --expected-sha <sha>',
    '',
    'github:authority pr',
    '  --repository-id <numeric-id>',
    '  --repository <owner/repo>',
    '  --pull-number <number>',
    '  --node-id <stable-node-id>',
    '  --state <open|closed>',
    '  --head-sha <sha>',
    '  --base-ref <ref>',
    '  --base-sha <sha>',
  ].join('\n');
}
