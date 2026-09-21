use crate::manifest::Manifest;
use std::ffi::{c_int, c_long, c_void};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const CGROUP_PARENT_FD: c_int = 4;
const CGROUP2_SUPER_MAGIC: c_long = 0x63677270;

unsafe extern "C" {
    fn fstatfs(fd: c_int, buffer: *mut c_void) -> c_int;
}

fn fail(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message.into())
}

fn parent_path() -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{CGROUP_PARENT_FD}"))
}

fn verify_cgroup2_parent() -> io::Result<()> {
    let mut buffer = [0u8; 256];
    if unsafe { fstatfs(CGROUP_PARENT_FD, buffer.as_mut_ptr().cast()) } != 0 {
        return Err(io::Error::new(
            io::Error::last_os_error().kind(),
            "missing delegated cgroup v2 parent on fd 4",
        ));
    }
    let filesystem_type = unsafe { std::ptr::read_unaligned(buffer.as_ptr().cast::<c_long>()) };
    if filesystem_type != CGROUP2_SUPER_MAGIC {
        return Err(fail(format!(
            "fd 4 is not a cgroup v2 filesystem: magic=0x{filesystem_type:x}"
        )));
    }
    Ok(())
}

fn require_controllers(parent: &Path) -> io::Result<()> {
    let enabled = fs::read_to_string(parent.join("cgroup.subtree_control"))?;
    for required in ["cpu", "memory", "pids"] {
        if !enabled.split_ascii_whitespace().any(|controller| controller == required) {
            return Err(fail(format!(
                "delegated cgroup parent is missing enabled {required} controller"
            )));
        }
    }
    Ok(())
}

fn write_exact(path: &Path, value: &str) -> io::Result<()> {
    fs::write(path, value)?;
    let observed = fs::read_to_string(path)?;
    if observed.trim() != value {
        return Err(fail(format!(
            "cgroup write did not settle exactly for {}: requested={value:?} observed={:?}",
            path.file_name().and_then(|name| name.to_str()).unwrap_or("<unknown>"),
            observed.trim(),
        )));
    }
    Ok(())
}

fn configure(child: &Path, manifest: &Manifest) -> io::Result<()> {
    write_exact(&child.join("memory.max"), &manifest.memory_max_bytes.to_string())?;
    write_exact(&child.join("memory.swap.max"), "0")?;
    write_exact(&child.join("memory.oom.group"), "1")?;
    write_exact(&child.join("pids.max"), &manifest.pids_max.to_string())?;
    write_exact(
        &child.join("cpu.max"),
        &format!("{} {}", manifest.cpu_quota_us, manifest.cpu_period_us),
    )?;
    Ok(())
}

fn migrate_self(child: &Path) -> io::Result<()> {
    let pid = std::process::id();
    fs::write(child.join("cgroup.procs"), pid.to_string())?;
    let members = fs::read_to_string(child.join("cgroup.procs"))?;
    if !members.lines().any(|member| member == pid.to_string()) {
        return Err(fail(format!("launcher pid {pid} did not enter resource cgroup")));
    }
    Ok(())
}

pub fn enter(manifest: &Manifest) -> io::Result<String> {
    verify_cgroup2_parent()?;
    let parent = parent_path();
    require_controllers(&parent)?;

    let name = format!("overcenter-{}", std::process::id());
    let child = parent.join(&name);
    fs::create_dir(&child)?;

    let result = (|| {
        configure(&child, manifest)?;
        migrate_self(&child)
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir(&child);
        return Err(error);
    }
    Ok(name)
}
