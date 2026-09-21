use crate::manifest::Manifest;
use crate::resource;
use std::collections::HashSet;
use std::ffi::{c_char, c_int, c_long, CString};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

const O_PATH: c_int = 0x200000;
const O_CLOEXEC: c_int = 0x80000;
const O_DIRECTORY: c_int = 0x10000;
const O_NOFOLLOW: c_int = 0x20000;
const PR_SET_NO_NEW_PRIVS: c_int = 38;
const PR_SET_SECCOMP: c_int = 22;
const SECCOMP_MODE_FILTER: c_int = 2;
const W_OK: c_int = 2;
const AT_EACCESS: c_int = 0x200;
const AT_EMPTY_PATH: c_int = 0x1000;
const EACCES: i32 = 13;
const EROFS: i32 = 30;
const SCHED_OTHER: c_int = 0;
const SCHED_BATCH: c_int = 3;
const SCHED_IDLE: c_int = 5;

const SYS_CAPGET: c_long = 125;
const SYS_CLOSE_RANGE: c_long = 436;
const SYS_FACCESSAT2: c_long = 439;
const SYS_LANDLOCK_CREATE_RULESET: c_long = 444;
const SYS_LANDLOCK_ADD_RULE: c_long = 445;
const SYS_LANDLOCK_RESTRICT_SELF: c_long = 446;
const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
const LANDLOCK_RULE_PATH_BENEATH: u32 = 1;

const ACCESS_FS_EXECUTE: u64 = 1 << 0;
const ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
const ACCESS_FS_READ_FILE: u64 = 1 << 2;
const ACCESS_FS_READ_DIR: u64 = 1 << 3;
const ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
const ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
const ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
const ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
const ACCESS_FS_MAKE_REG: u64 = 1 << 8;
const ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
const ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
const ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
const ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
const ACCESS_FS_REFER: u64 = 1 << 13;
const ACCESS_FS_TRUNCATE: u64 = 1 << 14;
const ACCESS_FS_IOCTL_DEV: u64 = 1 << 15;
const ACCESS_FS_RESOLVE_UNIX: u64 = 1 << 16;
const ACCESS_NET_BIND_TCP: u64 = 1 << 0;
const ACCESS_NET_CONNECT_TCP: u64 = 1 << 1;
const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;
const SCOPE_SIGNAL: u64 = 1 << 1;

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JMP_JEQ_K: u16 = 0x15;
const BPF_JMP_JGE_K: u16 = 0x35;
const BPF_ALU_AND_K: u16 = 0x54;
const BPF_RET_K: u16 = 0x06;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x80000000;
const SECCOMP_RET_ERRNO: u32 = 0x00050000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff0000;
const AUDIT_ARCH_X86_64: u32 = 0xc000003e;
const EPERM: u32 = 1;
const X32_SYSCALL_BIT: u32 = 0x40000000;
const SYS_MMAP: u32 = 9;
const SYS_MEMFD_CREATE: u32 = 319;
const SECCOMP_ARG1_LOW: u32 = 24;
const SECCOMP_ARG3_LOW: u32 = 40;
const MAP_HUGETLB: u32 = 0x40000;
const MFD_HUGETLB: u32 = 0x0004;
const DENIED_SYSCALLS: [u32; 34] = [
    29,  // shmget
    30,  // shmat
    31,  // shmctl
    41,  // socket
    53,  // socketpair
    64,  // semget
    65,  // semop
    66,  // semctl
    67,  // shmdt
    68,  // msgget
    69,  // msgsnd
    70,  // msgrcv
    71,  // msgctl
    109, // setpgid
    112, // setsid
    141, // setpriority
    142, // sched_setparam
    144, // sched_setscheduler
    203, // sched_setaffinity
    220, // semtimedop
    251, // ioprio_set
    302, // prlimit64
    314, // sched_setattr
    240, // mq_open
    241, // mq_unlink
    242, // mq_timedsend
    243, // mq_timedreceive
    244, // mq_notify
    245, // mq_getsetattr
    248, // add_key
    249, // request_key
    250, // keyctl
    425, // io_uring_setup
    438, // pidfd_getfd
];

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}

#[repr(C)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: c_int,
}

#[repr(C)]
struct CapabilityHeader {
    version: u32,
    pid: c_int,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CapabilityData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SockFilter {
    code: u16,
    jt: u8,
    jf: u8,
    k: u32,
}

#[repr(C)]
struct SockFprog {
    len: u16,
    filter: *const SockFilter,
}

unsafe extern "C" {
    fn dup(oldfd: c_int) -> c_int;
    fn geteuid() -> u32;
    fn getresuid(ruid: *mut u32, euid: *mut u32, suid: *mut u32) -> c_int;
    fn getresgid(rgid: *mut u32, egid: *mut u32, sgid: *mut u32) -> c_int;
    fn sched_getscheduler(pid: c_int) -> c_int;
    fn open(pathname: *const c_char, flags: c_int, ...) -> c_int;
    fn fchdir(fd: c_int) -> c_int;
    fn prctl(option: c_int, ...) -> c_int;
    fn syscall(number: c_long, ...) -> c_long;
}

fn cvt(rc: c_long) -> io::Result<c_long> {
    if rc < 0 { Err(io::Error::last_os_error()) } else { Ok(rc) }
}

fn ensure_unprivileged_caller() -> io::Result<()> {
    let mut ruid = 0;
    let mut euid = 0;
    let mut suid = 0;
    if unsafe { getresuid(&mut ruid, &mut euid, &mut suid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if euid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to launch an untrusted worker as effective uid 0",
        ));
    }
    if ruid != euid || euid != suid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("refusing caller with switchable uid state: real={ruid} effective={euid} saved={suid}"),
        ));
    }

    let mut rgid = 0;
    let mut egid = 0;
    let mut sgid = 0;
    if unsafe { getresgid(&mut rgid, &mut egid, &mut sgid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if rgid != egid || egid != sgid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("refusing caller with switchable gid state: real={rgid} effective={egid} saved={sgid}"),
        ));
    }

    const LINUX_CAPABILITY_VERSION_3: u32 = 0x20080522;
    let mut header = CapabilityHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let mut data = [CapabilityData {
        effective: 0,
        permitted: 0,
        inheritable: 0,
    }; 2];

    cvt(unsafe {
        syscall(
            SYS_CAPGET,
            &mut header as *mut CapabilityHeader,
            data.as_mut_ptr(),
        )
    })?;

    if data.iter().any(|set| set.effective != 0 || set.permitted != 0 || set.inheritable != 0) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to launch an untrusted worker with process capabilities",
        ));
    }

    let scheduling_policy = unsafe { sched_getscheduler(0) };
    if scheduling_policy < 0 {
        return Err(io::Error::last_os_error());
    }
    if !matches!(scheduling_policy, SCHED_OTHER | SCHED_BATCH | SCHED_IDLE) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "refusing scheduling policy {scheduling_policy}; cpu.max requires a fair-class worker"
            ),
        ));
    }
    Ok(())
}

fn open_path(path: &Path, directory: bool, nofollow: bool) -> io::Result<File> {
    let raw = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    let mut flags = O_PATH | O_CLOEXEC;
    if directory { flags |= O_DIRECTORY; }
    if nofollow { flags |= O_NOFOLLOW; }
    let fd = unsafe { open(raw.as_ptr(), flags) };
    if fd < 0 { return Err(io::Error::last_os_error()); }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn pin_workspace(manifest: &Manifest) -> io::Result<File> {
    const WORKSPACE_FD: c_int = 3;
    let fd = unsafe { dup(WORKSPACE_FD) };
    if fd < 0 {
        return Err(io::Error::new(
            io::Error::last_os_error().kind(),
            format!("missing exact workspace file descriptor on fd 3 for {}", manifest.workspace.display()),
        ));
    }
    let workspace = unsafe { File::from_raw_fd(fd) };
    let metadata = workspace.metadata()?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("workspace fd 3 for {} must name a directory", manifest.workspace.display()),
        ));
    }
    if metadata.dev() != manifest.workspace_dev || metadata.ino() != manifest.workspace_ino {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "workspace identity changed for {}: expected ({},{}), observed ({},{})",
                manifest.workspace.display(),
                manifest.workspace_dev, manifest.workspace_ino, metadata.dev(), metadata.ino(),
            ),
        ));
    }
    Ok(workspace)
}

fn landlock_abi() -> io::Result<i32> {
    let rc = unsafe {
        syscall(
            SYS_LANDLOCK_CREATE_RULESET,
            std::ptr::null::<RulesetAttr>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    Ok(cvt(rc)? as i32)
}

fn handled_fs_rights(abi: i32) -> io::Result<u64> {
    if abi < 6 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("Landlock ABI {abi} is too old; ABI >= 6 is required for process-scope isolation"),
        ));
    }
    let mut rights = ACCESS_FS_EXECUTE | ACCESS_FS_WRITE_FILE | ACCESS_FS_READ_FILE
        | ACCESS_FS_READ_DIR | ACCESS_FS_REMOVE_DIR | ACCESS_FS_REMOVE_FILE
        | ACCESS_FS_MAKE_CHAR | ACCESS_FS_MAKE_DIR | ACCESS_FS_MAKE_REG
        | ACCESS_FS_MAKE_SOCK | ACCESS_FS_MAKE_FIFO | ACCESS_FS_MAKE_BLOCK
        | ACCESS_FS_MAKE_SYM | ACCESS_FS_REFER | ACCESS_FS_TRUNCATE;
    if abi >= 5 { rights |= ACCESS_FS_IOCTL_DEV; }
    if abi >= 9 { rights |= ACCESS_FS_RESOLVE_UNIX; }
    Ok(rights)
}

fn workspace_access_rights(handled_fs: u64) -> u64 {
    handled_fs
        & !(ACCESS_FS_EXECUTE
            | ACCESS_FS_MAKE_CHAR
            | ACCESS_FS_MAKE_BLOCK
            | ACCESS_FS_MAKE_SOCK
            | ACCESS_FS_IOCTL_DEV
            | ACCESS_FS_RESOLVE_UNIX)
}

fn create_ruleset(abi: i32, handled_fs: u64) -> io::Result<File> {
    let attr = RulesetAttr {
        handled_access_fs: handled_fs,
        handled_access_net: if abi >= 4 { ACCESS_NET_BIND_TCP | ACCESS_NET_CONNECT_TCP } else { 0 },
        scoped: if abi >= 6 { SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL } else { 0 },
    };
    let attr_size = if abi >= 6 {
        std::mem::size_of::<RulesetAttr>()
    } else if abi >= 4 {
        2 * std::mem::size_of::<u64>()
    } else {
        std::mem::size_of::<u64>()
    };
    let fd = unsafe {
        syscall(
            SYS_LANDLOCK_CREATE_RULESET,
            &attr as *const RulesetAttr,
            attr_size,
            0u32,
        )
    };
    Ok(unsafe { File::from_raw_fd(cvt(fd)? as c_int) })
}

fn add_fd_rule(ruleset: &File, object: &File, allowed_access: u64) -> io::Result<()> {
    let metadata = object.metadata()?;
    let allowed_access = if metadata.is_dir() {
        allowed_access | ACCESS_FS_READ_DIR
    } else {
        allowed_access & !ACCESS_FS_READ_DIR
    };
    let attr = PathBeneathAttr { allowed_access, parent_fd: object.as_raw_fd() };
    let rc = unsafe {
        syscall(
            SYS_LANDLOCK_ADD_RULE,
            ruleset.as_raw_fd(),
            LANDLOCK_RULE_PATH_BENEATH,
            &attr as *const PathBeneathAttr,
            0u32,
        )
    };
    cvt(rc)?;
    Ok(())
}

fn open_regular(path: &Path) -> io::Result<File> {
    let object = open_path(path, false, false)?;
    if !object.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("execution closure path must name a regular file: {}", path.display()),
        ));
    }
    Ok(object)
}

fn require_worker_immutable(object: &File, path: &Path) -> io::Result<()> {
    let metadata = object.metadata()?;
    let euid = unsafe { geteuid() };
    if metadata.uid() == euid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("execution closure object is owned by worker uid {euid}: {}", path.display()),
        ));
    }

    let writable = unsafe {
        syscall(
            SYS_FACCESSAT2,
            object.as_raw_fd(),
            b"\0".as_ptr() as *const c_char,
            W_OK,
            AT_EMPTY_PATH | AT_EACCESS,
        )
    };
    if writable == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("execution closure object is writable by worker credentials: {}", path.display()),
        ));
    }
    let error = io::Error::last_os_error();
    if !matches!(error.raw_os_error(), Some(EACCES) | Some(EROFS)) {
        return Err(io::Error::new(
            error.kind(),
            format!("cannot prove execution closure object is immutable to worker: {}: {error}", path.display()),
        ));
    }
    Ok(())
}

fn add_program_rule(ruleset: &File, path: &Path, allowed_access: u64) -> io::Result<()> {
    let object = open_regular(path)?;
    require_worker_immutable(&object, path)?;
    add_fd_rule(ruleset, &object, allowed_access)
}

fn add_runtime_rule(
    ruleset: &File,
    path: &Path,
    allowed_access: u64,
    seen: &mut HashSet<(u64, u64)>,
) -> io::Result<()> {
    let object = open_regular(path)?;
    let metadata = object.metadata()?;
    let identity = (metadata.dev(), metadata.ino());
    if !seen.insert(identity) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("duplicate runtime object identity: {}", path.display()),
        ));
    }
    require_worker_immutable(&object, path)?;
    add_fd_rule(ruleset, &object, allowed_access)
}

fn restrict_self(ruleset: &File) -> io::Result<()> {
    let rc = unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if rc != 0 { return Err(io::Error::last_os_error()); }
    cvt(unsafe { syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset.as_raw_fd(), 0u32) })?;
    Ok(())
}

const fn stmt(code: u16, k: u32) -> SockFilter { SockFilter { code, jt: 0, jf: 0, k } }
const fn jump(code: u16, k: u32, jt: u8, jf: u8) -> SockFilter { SockFilter { code, jt, jf, k } }

fn deny_flagged_syscall(
    filters: &mut Vec<SockFilter>,
    syscall_number: u32,
    argument_offset: u32,
    denied_flags: u32,
    errno: u32,
) {
    filters.push(jump(BPF_JMP_JEQ_K, syscall_number, 0, 5));
    filters.push(stmt(BPF_LD_W_ABS, argument_offset));
    filters.push(stmt(BPF_ALU_AND_K, denied_flags));
    filters.push(jump(BPF_JMP_JEQ_K, 0, 1, 0));
    filters.push(stmt(BPF_RET_K, errno));
    filters.push(stmt(BPF_LD_W_ABS, 0));
}

fn install_seccomp_policy() -> io::Result<()> {
    let errno = SECCOMP_RET_ERRNO | EPERM;
    let mut filters = vec![
        stmt(BPF_LD_W_ABS, 4),
        jump(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, 1, 0),
        stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
        stmt(BPF_LD_W_ABS, 0),
        // x32 syscalls share AUDIT_ARCH_X86_64 but set bit 30 in nr. Reject
        // the namespace before matching native syscall numbers.
        jump(BPF_JMP_JGE_K, X32_SYSCALL_BIT, 0, 1),
        stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
    ];
    deny_flagged_syscall(
        &mut filters,
        SYS_MMAP,
        SECCOMP_ARG3_LOW,
        MAP_HUGETLB,
        errno,
    );
    deny_flagged_syscall(
        &mut filters,
        SYS_MEMFD_CREATE,
        SECCOMP_ARG1_LOW,
        MFD_HUGETLB,
        errno,
    );
    for syscall_number in DENIED_SYSCALLS {
        filters.push(jump(BPF_JMP_JEQ_K, syscall_number, 0, 1));
        filters.push(stmt(BPF_RET_K, errno));
    }
    filters.push(stmt(BPF_RET_K, SECCOMP_RET_ALLOW));

    let len = u16::try_from(filters.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "seccomp program is too large"))?;
    let program = SockFprog { len, filter: filters.as_ptr() };
    let rc = unsafe { prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program as *const SockFprog) };
    if rc != 0 { return Err(io::Error::last_os_error()); }
    Ok(())
}

fn close_inherited_fds() -> io::Result<()> {
    cvt(unsafe { syscall(SYS_CLOSE_RANGE, 3u32, u32::MAX, 0u32) })?;
    Ok(())
}

pub fn execute(manifest: Manifest) -> io::Result<()> {
    ensure_unprivileged_caller()?;
    resource::enter(&manifest)?;
    let workspace = pin_workspace(&manifest)?;
    let abi = landlock_abi()?;
    let handled_fs = handled_fs_rights(abi)?;
    let ruleset = create_ruleset(abi, handled_fs)?;

    add_fd_rule(&ruleset, &workspace, workspace_access_rights(handled_fs))?;
    add_program_rule(&ruleset, &manifest.program, ACCESS_FS_READ_FILE | ACCESS_FS_EXECUTE)?;
    let mut runtime_seen = HashSet::new();
    for path in &manifest.runtime_read_only {
        add_runtime_rule(&ruleset, path, ACCESS_FS_READ_FILE, &mut runtime_seen)?;
    }
    for path in &manifest.runtime_executable {
        add_runtime_rule(
            &ruleset,
            path,
            ACCESS_FS_READ_FILE | ACCESS_FS_EXECUTE,
            &mut runtime_seen,
        )?;
    }

    if unsafe { fchdir(workspace.as_raw_fd()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    restrict_self(&ruleset)?;
    drop(ruleset);
    drop(workspace);
    close_inherited_fds()?;
    install_seccomp_policy()?;

    eprintln!(
        "overcenter-exec: task_id={:?} landlock_abi={abi} cgroup_fd=4 timeout_ms={} max_output_bytes={} memory_max_bytes={} pids_max={} cpu_max={}/{}",
        manifest.task_id,
        manifest.timeout_ms,
        manifest.max_output_bytes,
        manifest.memory_max_bytes,
        manifest.pids_max,
        manifest.cpu_quota_us,
        manifest.cpu_period_us,
    );
    let mut command = Command::new(&manifest.program);
    command.args(&manifest.args).env_clear();
    for (name, value) in &manifest.environment { command.env(name, value); }
    Err(command.exec())
}
