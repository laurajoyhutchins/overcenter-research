#![cfg(target_os = "linux")]
#![cfg(target_arch = "x86_64")]

use std::env;
use std::ffi::{c_char, c_int, c_long, CString};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};
use std::process;

const TASK_ID: &str = env!("OVERCENTER_TASK_ID");
const TASK_ROOT: &str = env!("OVERCENTER_TASK_ROOT");
const TASK_ROOT_DEV: u64 = parse_u64(env!("OVERCENTER_TASK_ROOT_DEV"));
const TASK_ROOT_INO: u64 = parse_u64(env!("OVERCENTER_TASK_ROOT_INO"));

const O_RDONLY: c_int = 0;
const O_CLOEXEC: c_int = 0x80000;
const O_DIRECTORY: c_int = 0x10000;
const O_NOFOLLOW: c_int = 0x20000;

const SYS_OPENAT2: c_long = 437;
const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

unsafe extern "C" {
    fn open(pathname: *const c_char, flags: c_int, ...) -> c_int;
    fn syscall(number: c_long, ...) -> c_long;
}

const fn parse_u64(s: &str) -> u64 {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut value = 0u64;
    while i < bytes.len() {
        let b = bytes[i];
        assert!(b >= b'0' && b <= b'9');
        value = value * 10 + (b - b'0') as u64;
        i += 1;
    }
    value
}

fn fail(message: impl AsRef<str>) -> ! {
    eprintln!("{}", message.as_ref());
    process::exit(2);
}

fn validate_relative(path: &Path) -> io::Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must be non-empty and relative",
        ));
    }

    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "only normal relative path components are permitted",
                ))
            }
        }
    }

    Ok(())
}

fn open_bound_root() -> io::Result<File> {
    let root = CString::new(TASK_ROOT.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "task root contains NUL"))?;

    let fd = unsafe {
        open(
            root.as_ptr(),
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if metadata.dev() != TASK_ROOT_DEV || metadata.ino() != TASK_ROOT_INO {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "task root identity changed after capsule compilation",
        ));
    }

    Ok(file)
}

fn open_beneath(root_fd: RawFd, relative: &Path) -> io::Result<File> {
    validate_relative(relative)?;

    let path = CString::new(relative.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;

    let how = OpenHow {
        flags: (O_RDONLY | O_CLOEXEC) as u64,
        mode: 0,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS,
    };

    let fd = unsafe {
        syscall(
            SYS_OPENAT2,
            root_fd,
            path.as_ptr(),
            &how as *const OpenHow,
            std::mem::size_of::<OpenHow>(),
        )
    };

    if fd < 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(unsafe { File::from_raw_fd(fd as RawFd) })
}

fn read_task_file(relative: &Path) -> io::Result<String> {
    let root = open_bound_root()?;
    let mut file = open_beneath(root.as_raw_fd(), relative)?;
    let mut content = String::new();
    file.read_to_string(&mut content)?;
    Ok(content)
}

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("describe") if args.next().is_none() => {
            println!("task_id={TASK_ID}");
            println!("task_root={TASK_ROOT}");
            println!("task_root_dev={TASK_ROOT_DEV}");
            println!("task_root_ino={TASK_ROOT_INO}");
            println!("operations=describe,read");
        }
        Some("read") => {
            let Some(relative) = args.next() else {
                fail("usage: capsule read <relative-path>");
            };
            if args.next().is_some() {
                fail("usage: capsule read <relative-path>");
            }
            match read_task_file(Path::new(&relative)) {
                Ok(content) => print!("{content}"),
                Err(error) => fail(format!("read denied: {error}")),
            }
        }
        _ => fail("allowed commands: describe, read"),
    }
}
