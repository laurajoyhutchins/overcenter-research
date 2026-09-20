use crate::manifest::Manifest;
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

const SYS_CLOSE_RANGE: c_long = 436;
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
const BPF_RET_K: u16 = 0x06;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x80000000;
const SECCOMP_RET_ERRNO: u32 = 0x00050000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff0000;
const AUDIT_ARCH_X86_64: u32 = 0xc000003e;
const EPERM: u32 = 1;
const SYS_SOCKET: u32 = 41;
const SYS_SOCKETPAIR: u32 = 53;
const SYS_IO_URING_SETUP: u32 = 425;
const SYS_PIDFD_GETFD: u32 = 438;

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
    fn open(pathname: *const c_char, flags: c_int, ...) -> c_int;
    fn fchdir(fd: c_int) -> c_int;
    fn prctl(option: c_int, ...) -> c_int;
    fn syscall(number: c_long, ...) -> c_long;
}

fn cvt(rc: c_long) -> io::Result<c_long> {
    if rc < 0 { Err(io::Error::last_os_error()) } else { Ok(rc) }
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
    let workspace = open_path(&manifest.workspace, true, true)?;
    let metadata = workspace.metadata()?;
    if metadata.dev() != manifest.workspace_dev || metadata.ino() != manifest.workspace_ino {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "workspace identity changed: expected ({},{}), observed ({},{})",
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
    if abi < 3 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("Landlock ABI {abi} is too old; ABI >= 3 is required"),
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

fn add_path_rule(ruleset: &File, path: &Path, allowed_access: u64) -> io::Result<()> {
    let object = open_path(path, false, false)?;
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

fn install_socket_deny_seccomp() -> io::Result<()> {
    let errno = SECCOMP_RET_ERRNO | EPERM;
    let filters = [
        stmt(BPF_LD_W_ABS, 4),
        jump(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, 1, 0),
        stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
        stmt(BPF_LD_W_ABS, 0),
        jump(BPF_JMP_JEQ_K, SYS_SOCKET, 0, 1), stmt(BPF_RET_K, errno),
        jump(BPF_JMP_JEQ_K, SYS_SOCKETPAIR, 0, 1), stmt(BPF_RET_K, errno),
        jump(BPF_JMP_JEQ_K, SYS_IO_URING_SETUP, 0, 1), stmt(BPF_RET_K, errno),
        jump(BPF_JMP_JEQ_K, SYS_PIDFD_GETFD, 0, 1), stmt(BPF_RET_K, errno),
        stmt(BPF_RET_K, SECCOMP_RET_ALLOW),
    ];
    let program = SockFprog { len: filters.len() as u16, filter: filters.as_ptr() };
    let rc = unsafe { prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program as *const SockFprog) };
    if rc != 0 { return Err(io::Error::last_os_error()); }
    Ok(())
}

fn close_inherited_fds() -> io::Result<()> {
    cvt(unsafe { syscall(SYS_CLOSE_RANGE, 3u32, u32::MAX, 0u32) })?;
    Ok(())
}

pub fn execute(manifest: Manifest) -> io::Result<()> {
    let workspace = pin_workspace(&manifest)?;
    let abi = landlock_abi()?;
    let handled_fs = handled_fs_rights(abi)?;
    let ruleset = create_ruleset(abi, handled_fs)?;

    add_fd_rule(&ruleset, &workspace, handled_fs)?;
    add_path_rule(&ruleset, &manifest.program, ACCESS_FS_READ_FILE | ACCESS_FS_EXECUTE)?;
    for path in &manifest.runtime_read_only {
        add_path_rule(&ruleset, path, ACCESS_FS_READ_FILE)?;
    }
    for path in &manifest.runtime_executable {
        add_path_rule(&ruleset, path, ACCESS_FS_READ_FILE | ACCESS_FS_EXECUTE)?;
    }

    if unsafe { fchdir(workspace.as_raw_fd()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    restrict_self(&ruleset)?;
    drop(ruleset);
    drop(workspace);
    close_inherited_fds()?;
    install_socket_deny_seccomp()?;

    eprintln!("overcenter-exec: task_id={} landlock_abi={abi}", manifest.task_id);
    let mut command = Command::new(&manifest.program);
    command.args(&manifest.args).env_clear();
    for (name, value) in &manifest.environment { command.env(name, value); }
    Err(command.exec())
}
