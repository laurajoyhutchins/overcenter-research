use crate::manifest::Manifest;
use std::ffi::{c_int, c_long, c_void};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const CGROUP_LEAF_FD: c_int = 4;
const CGROUP2_SUPER_MAGIC: c_long = 0x63677270;

unsafe extern "C" {
    fn fstatfs(fd: c_int, buffer: *mut c_void) -> c_int;
}

fn fail(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message.into())
}

fn leaf_path() -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{CGROUP_LEAF_FD}"))
}

fn verify_cgroup2_leaf() -> io::Result<()> {
    let mut buffer = [0u8; 256];
    if unsafe { fstatfs(CGROUP_LEAF_FD, buffer.as_mut_ptr().cast()) } != 0 {
        return Err(io::Error::new(
            io::Error::last_os_error().kind(),
            "missing exact cgroup v2 leaf on fd 4",
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

fn require_leaf_interfaces(leaf: &Path) -> io::Result<()> {
    let cgroup_type = fs::read_to_string(leaf.join("cgroup.type"))?;
    if cgroup_type.trim() != "domain" {
        return Err(fail(format!(
            "resource cgroup must be a domain leaf, observed {:?}",
            cgroup_type.trim(),
        )));
    }

    for interface in [
        "cgroup.procs",
        "cgroup.events",
        "cgroup.kill",
        "memory.max",
        "memory.swap.max",
        "memory.oom.group",
        "pids.max",
        "cpu.max",
    ] {
        if !leaf.join(interface).exists() {
            return Err(fail(format!("resource cgroup is missing {interface}")));
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

fn configure(leaf: &Path, manifest: &Manifest) -> io::Result<()> {
    write_exact(&leaf.join("memory.max"), &manifest.memory_max_bytes.to_string())?;
    write_exact(&leaf.join("memory.swap.max"), "0")?;
    write_exact(&leaf.join("memory.oom.group"), "1")?;
    write_exact(&leaf.join("pids.max"), &manifest.pids_max.to_string())?;
    write_exact(
        &leaf.join("cpu.max"),
        &format!("{} {}", manifest.cpu_quota_us, manifest.cpu_period_us),
    )?;
    Ok(())
}

fn migrate_self(leaf: &Path) -> io::Result<()> {
    let pid = std::process::id();
    fs::write(leaf.join("cgroup.procs"), pid.to_string())?;
    let members = fs::read_to_string(leaf.join("cgroup.procs"))?;
    if !members.lines().any(|member| member == pid.to_string()) {
        return Err(fail(format!("launcher pid {pid} did not enter exact resource cgroup")));
    }
    Ok(())
}

pub fn enter(manifest: &Manifest) -> io::Result<()> {
    verify_cgroup2_leaf()?;
    let leaf = leaf_path();
    require_leaf_interfaces(&leaf)?;
    configure(&leaf, manifest)?;
    migrate_self(&leaf)
}
