import { execFileSync } from 'node:child_process';

export interface GcpJsonGetRequest {
  authority_host:string;
  path:string;
  headers:Record<string,string>;
}

export type GcpJsonGet=(accessToken:string,request:GcpJsonGetRequest)=>unknown;

const GCP_API_HOST=/^(?:[a-z0-9-]+\.)+googleapis\.com$/;

export function assertGcpAuthorityHost(value:string):string {
  if (!GCP_API_HOST.test(value) || value.includes('..')) {
    throw new Error('GCP_AUTHORITY_HOST_INVALID');
  }
  return value;
}

function safeHeader(name:string,value:string):string {
  if (
    !/^[A-Za-z0-9-]+$/.test(name)
    || value.length===0
    || /[\r\n"]/.test(value)
  ) {
    throw new Error('GCP_PROVIDER_HEADER_INVALID');
  }
  return `${name}: ${value}`;
}

export function gcpGet(
  accessToken:string,
  request:GcpJsonGetRequest,
):unknown {
  if (accessToken.length===0) throw new Error('GCP_ACCESS_TOKEN_REQUIRED');
  const authorityHost=assertGcpAuthorityHost(request.authority_host);
  if (!request.path.startsWith('/')) throw new Error('GCP_REQUEST_PATH_INVALID');

  const config=[
    `header = "${safeHeader('Authorization',`Bearer ${accessToken}`)}"`,
    ...Object.entries(request.headers).map(
      ([name,value])=>`header = "${safeHeader(name,value)}"`,
    ),
    '',
  ].join('\n');

  try {
    const stdout=execFileSync(
      'curl',
      [
        '--silent',
        '--show-error',
        '--fail-with-body',
        '--config',
        '-',
        `https://${authorityHost}${request.path}`,
      ],
      {input:config,encoding:'utf8',stdio:['pipe','pipe','pipe']},
    );
    return JSON.parse(stdout);
  } catch (error:unknown) {
    const failure=error as {
      stderr?:string|Buffer;
      stdout?:string|Buffer;
      message?:string;
    };
    throw new Error(
      `GCP_PROVIDER_READ_FAILED: ${String(
        failure.stderr??failure.stdout??failure.message??'',
      ).trim()}`,
    );
  }
}
