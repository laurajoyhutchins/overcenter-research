#![cfg(target_os = "linux")]
#![cfg(target_arch = "x86_64")]

use std::env;
use std::ffi::{c_char, c_int, c_long, CString};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::Path;
use std::process::{Command, ExitCode};

const O_PATH: c_int = 0x200000;
const O_CLOEXEC: c_int = 0x80000;

const PR_SET_NO_NEW_PRIVS: c_int = 38;

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

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
}

#[repr(C)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: c_int,
}

unsafe extern "C" {
    fn open(pathname: *const c_char, flags: c_int, ...) -> c_int;
    fn prctl(option: c_int, ...) -> c_int;
    fn syscall(number: c_long, ...) -> c_long;
}

fn cvt(rc: c_long) -> io::Result<c_long> {
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(rc)
    }
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

fn handled_rights(abi: i32) -> io::Result<u64> {
    if abi < 3 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("Landlock ABI {abi} is too old; this experiment requires ABI >= 3"),
        ));
    }

    let v1_without_execute = ACCESS_FS_WRITE_FILE
        | ACCESS_FS_READ_FILE
        | ACCESS_FS_READ_DIR
        | ACCESS_FS_REMOVE_DIR
        | ACCESS_FS_REMOVE_FILE
        | ACCESS_FS_MAKE_CHAR
        | ACCESS_FS_MAKE_DIR
        | ACCESS_FS_MAKE_REG
        | ACCESS_FS_MAKE_SOCK
        | ACCESS_FS_MAKE_FIFO
        | ACCESS_FS_MAKE_BLOCK
        | ACCESS_FS_MAKE_SYM;

    Ok(v1_without_execute | ACCESS_FS_REFER | ACCESS_FS_TRUNCATE)
}

fn open_path(path: &Path) -> io::Result<File> {
    let raw = CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;

    let fd = unsafe { open(raw.as_ptr(), O_PATH | O_CLOEXEC) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(unsafe { File::from_raw_fd(fd) })
}

fn add_path_rule(ruleset: &File, path: &Path, allowed_access: u64) -> io::Result<()> {
    if allowed_access == 0 {
        return Ok(());
    }

    let object = open_path(path)?;
    let attr = PathBeneathAttr {
        allowed_access,
        parent_fd: object.as_raw_fd(),
    };

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

fn create_ruleset(handled_access_fs: u64) -> io::Result<File> {
    let attr = RulesetAttr { handled_access_fs };
    let fd = unsafe {
        syscall(
            SYS_LANDLOCK_CREATE_RULESET,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0u32,
        )
    };
    let fd = cvt(fd)? as c_int;
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn restrict_self(ruleset: &File) -> io::Result<()> {
    let rc = unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }

    let rc = unsafe { syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset.as_raw_fd(), 0u32) };
    cvt(rc)?;
    Ok(())
}

fn add_readonly_runtime_rules(ruleset: &File, handled: u64) -> io::Result<()> {
    let dir_read = (ACCESS_FS_READ_FILE | ACCESS_FS_READ_DIR) & handled;
    let file_read = ACCESS_FS_READ_FILE & handled;

    for path in ["/usr", "/lib", "/lib64", "/bin", "/proc"] {
        let p = Path::new(path);
        if p.exists() {
            add_path_rule(ruleset, p, dir_read)?;
        }
    }

    for path in ["/etc/ld.so.cache", "/etc/localtime"] {
        let p = Path::new(path);
        if p.exists() {
            add_path_rule(ruleset, p, file_read)?;
        }
    }

    Ok(())
}

fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    let Some(task_root) = args.next() else {
        eprintln!("usage: landlock_launcher <task-root> <worker> [worker-args...]");
        return ExitCode::from(2);
    };
    let Some(worker) = args.next() else {
        eprintln!("usage: landlock_launcher <task-root> <worker> [worker-args...]");
        return ExitCode::from(2);
    };
    let worker_args: Vec<_> = args.collect();

    let task_root = Path::new(&task_root);
    let worker = Path::new(&worker);

    let result = (|| -> io::Result<i32> {
        let abi = landlock_abi()?;
        let handled = handled_rights(abi)?;
        eprintln!("landlock_abi={abi}");

        let ruleset = create_ruleset(handled)?;
        add_path_rule(&ruleset, task_root, handled)?;
        add_readonly_runtime_rules(&ruleset, handled)?;
        restrict_self(&ruleset)?;
        drop(ruleset);

        let status = Command::new(worker)
            .args(worker_args)
            .current_dir(task_root)
            .env_clear()
            .env("OVERCENTER_SANDBOX", "landlock")
            .status()?;

        Ok(status.code().unwrap_or(1))
    })();

    match result {
        Ok(code) => ExitCode::from(code as u8),
        Err(error) => {
            eprintln!("landlock launcher failed: {error}");
            ExitCode::from(1)
        }
    }
}
