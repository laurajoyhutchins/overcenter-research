export const PRODUCTION_COMPUTATION_CONTAINMENT = {
  schema:'overcenter-production-containment-v1',
  network:'none',
  read_only_root:true,
  no_new_privileges:true,
  cap_drop:['ALL'],
  cap_add:['CHOWN','DAC_OVERRIDE','KILL','SETGID','SETUID'],
  pids_limit:256,
  memory_bytes:1024*1024*1024,
  memory_swap_bytes:1024*1024*1024,
  nano_cpus:1_000_000_000,
  nofile:256,
  file_size_bytes:64*1024*1024,
  task_uid:65532,
  task_gid:65532,
  executor_concurrency:1,
  tmpfs:{
    path:'/tmp',
    options:'rw,nosuid,nodev,size=67108864',
  },
  source:'read-only',
  workspace:'fresh-empty-disposable-host-workspace',
} as const;

export function productionDockerIsolationArgs():string[] {
  const profile=PRODUCTION_COMPUTATION_CONTAINMENT;
  return [
    `--network=${profile.network}`,
    '--read-only',
    '--security-opt=no-new-privileges:true',
    ...profile.cap_drop.flatMap(capability=>['--cap-drop',capability]),
    ...profile.cap_add.flatMap(capability=>['--cap-add',capability]),
    `--pids-limit=${profile.pids_limit}`,
    `--memory=${profile.memory_bytes}`,
    `--memory-swap=${profile.memory_swap_bytes}`,
    `--cpus=${profile.nano_cpus/1_000_000_000}`,
    `--ulimit=nofile=${profile.nofile}:${profile.nofile}`,
    `--ulimit=fsize=${profile.file_size_bytes}:${profile.file_size_bytes}`,
    '--tmpfs',
    `${profile.tmpfs.path}:${profile.tmpfs.options}`,
  ];
}

export function productionExecutorArgs(input:{
  socketPath:string;
  workspaceRoot:string;
  socketGid:number;
  executionContextSha256:string;
  containmentId:string;
}):string[] {
  const profile=PRODUCTION_COMPUTATION_CONTAINMENT;
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
