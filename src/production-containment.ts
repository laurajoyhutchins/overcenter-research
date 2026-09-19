export const PRODUCTION_CONTAINMENT_PROFILE={
  schema:'overcenter-production-containment-v1',
  network:'none',
  read_only_root:true,
  no_new_privileges:true,
  cap_drop:['ALL'],
  cap_add:['CHOWN','DAC_OVERRIDE','KILL','SETGID','SETUID'],
  pids_limit:128,
  memory_bytes:512*1024*1024,
  memory_swap_bytes:512*1024*1024,
  cpus:1,
  nofile:256,
  file_size_bytes:64*1024*1024,
  temp:{
    path:'/tmp',
    bytes:64*1024*1024,
    options:['rw','nosuid','nodev'],
  },
  task_uid:65532,
  task_gid:65532,
  executor_concurrency:1,
  source:'read-only',
  workspace:'fresh-empty-disposable-host-workspace',
} as const;

export function productionDockerRunArgs():string[] {
  const profile=PRODUCTION_CONTAINMENT_PROFILE;
  return [
    `--network=${profile.network}`,
    ...(profile.read_only_root?['--read-only']:[]),
    ...(profile.no_new_privileges?['--security-opt=no-new-privileges:true']:[]),
    ...profile.cap_drop.map(capability=>`--cap-drop=${capability}`),
    ...profile.cap_add.map(capability=>`--cap-add=${capability}`),
    `--pids-limit=${profile.pids_limit}`,
    `--memory=${profile.memory_bytes}`,
    `--memory-swap=${profile.memory_swap_bytes}`,
    `--cpus=${profile.cpus}`,
    `--ulimit=nofile=${profile.nofile}:${profile.nofile}`,
    `--ulimit=fsize=${profile.file_size_bytes}:${profile.file_size_bytes}`,
    `--tmpfs=${profile.temp.path}:${[...profile.temp.options,`size=${profile.temp.bytes}`].join(',')}`,
  ];
}

export interface ProductionExecutorSocketArgs {
  socketPath:string;
  workspaceRoot:string;
  socketGid:number;
  executionContextSha256:string;
  containmentId:string;
}

export function productionExecutorSocketArgs(input:ProductionExecutorSocketArgs):string[] {
  const profile=PRODUCTION_CONTAINMENT_PROFILE;
  return [
    `--socket=${input.socketPath}`,
    `--workspace-root=${input.workspaceRoot}`,
    `--concurrency=${profile.executor_concurrency}`,
    `--task-uid=${profile.task_uid}`,
    `--task-gid=${profile.task_gid}`,
    `--socket-gid=${input.socketGid}`,
    `--execution-context-sha256=${input.executionContextSha256}`,
    `--containment-id=${input.containmentId}`,
  ];
}
