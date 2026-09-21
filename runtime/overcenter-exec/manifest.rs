use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Debug)]
pub struct Manifest {
    pub task_id: String,
    pub workspace: PathBuf,
    pub workspace_dev: u64,
    pub workspace_ino: u64,
    pub program: PathBuf,
    pub timeout_ms: u64,
    pub max_output_bytes: u64,
    pub memory_max_bytes: u64,
    pub pids_max: u64,
    pub cpu_quota_us: u64,
    pub cpu_period_us: u64,
    pub args: Vec<String>,
    pub environment: Vec<(String, String)>,
    pub runtime_read_only: Vec<PathBuf>,
    pub runtime_executable: Vec<PathBuf>,
}

fn parse_u64(name: &str, value: &str) -> Result<u64, String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{name} must be decimal"));
    }
    if value.len() > 1 && value.starts_with('0') {
        return Err(format!("{name} must use canonical decimal"));
    }
    value.parse::<u64>().map_err(|_| format!("{name} is out of range"))
}

fn parse_bounded_positive_u64(name: &str, value: &str, maximum: u64) -> Result<u64, String> {
    let parsed = parse_u64(name, value)?;
    if parsed == 0 || parsed > maximum {
        return Err(format!("{name} must be between 1 and {maximum}"));
    }
    Ok(parsed)
}

fn validate_atom(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    if value.as_bytes().contains(&0) || value.contains('\r') || value.contains('\n') {
        return Err(format!("{name} contains a forbidden byte"));
    }
    Ok(())
}

fn validate_absolute(name: &str, value: &str) -> Result<PathBuf, String> {
    validate_atom(name, value)?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!("{name} must be absolute"));
    }
    Ok(path)
}

fn validate_env_name(name: &str) -> Result<(), String> {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return Err("environment name must not be empty".to_owned());
    };
    if !(first == b'_' || first.is_ascii_alphabetic())
        || !bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
    {
        return Err(format!("invalid environment name: {name}"));
    }
    Ok(())
}

fn set_once<T>(slot: &mut Option<T>, value: T, name: &str) -> Result<(), String> {
    if slot.replace(value).is_some() {
        return Err(format!("duplicate {name}"));
    }
    Ok(())
}

pub fn parse_manifest(input: &str) -> Result<Manifest, String> {
    if input.is_empty() || !input.ends_with('\n') {
        return Err("manifest must end with exactly one newline-delimited record stream".to_owned());
    }
    if input.contains('\r') {
        return Err("manifest contains carriage return".to_owned());
    }

    let mut lines = input.lines();
    if lines.next() != Some("OVERCENTER_EXEC_V1") {
        return Err("unsupported manifest header".to_owned());
    }

    let mut task_id = None;
    let mut workspace = None;
    let mut workspace_dev = None;
    let mut workspace_ino = None;
    let mut program = None;
    let mut timeout_ms = None;
    let mut max_output_bytes = None;
    let mut memory_max_bytes = None;
    let mut pids_max = None;
    let mut cpu_quota_us = None;
    let mut cpu_period_us = None;
    let mut args = Vec::new();
    let mut environment = Vec::new();
    let mut runtime_read_only = Vec::new();
    let mut runtime_executable = Vec::new();
    let mut environment_names = HashSet::new();
    let mut runtime_ro_seen = HashSet::new();
    let mut runtime_exec_seen = HashSet::new();

    for (offset, line) in lines.enumerate() {
        let line_number = offset + 2;
        if line.is_empty() {
            return Err(format!("empty manifest record at line {line_number}"));
        }
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["task_id", value] => {
                validate_atom("task_id", value)?;
                set_once(&mut task_id, (*value).to_owned(), "task_id")?;
            }
            ["workspace", value] => {
                set_once(&mut workspace, validate_absolute("workspace", value)?, "workspace")?;
            }
            ["workspace_dev", value] => {
                set_once(&mut workspace_dev, parse_u64("workspace_dev", value)?, "workspace_dev")?;
            }
            ["workspace_ino", value] => {
                set_once(&mut workspace_ino, parse_u64("workspace_ino", value)?, "workspace_ino")?;
            }
            ["program", value] => {
                set_once(&mut program, validate_absolute("program", value)?, "program")?;
            }
            ["timeout_ms", value] => {
                set_once(&mut timeout_ms, parse_bounded_positive_u64("timeout_ms", value, 2_147_483_647)?, "timeout_ms")?;
            }
            ["max_output_bytes", value] => {
                set_once(
                    &mut max_output_bytes,
                    parse_bounded_positive_u64("max_output_bytes", value, 67_108_864)?,
                    "max_output_bytes",
                )?;
            }
            ["memory_max_bytes", value] => {
                set_once(
                    &mut memory_max_bytes,
                    parse_bounded_positive_u64("memory_max_bytes", value, u64::MAX)?,
                    "memory_max_bytes",
                )?;
            }
            ["pids_max", value] => {
                set_once(
                    &mut pids_max,
                    parse_bounded_positive_u64("pids_max", value, u64::MAX)?,
                    "pids_max",
                )?;
            }
            ["cpu_quota_us", value] => {
                set_once(
                    &mut cpu_quota_us,
                    parse_bounded_positive_u64("cpu_quota_us", value, u64::MAX)?,
                    "cpu_quota_us",
                )?;
            }
            ["cpu_period_us", value] => {
                set_once(
                    &mut cpu_period_us,
                    parse_bounded_positive_u64("cpu_period_us", value, u64::MAX)?,
                    "cpu_period_us",
                )?;
            }
            ["arg", value] => {
                validate_atom("arg", value)?;
                args.push((*value).to_owned());
            }
            ["env", name, value] => {
                validate_env_name(name)?;
                validate_atom("environment value", value)?;
                if !environment_names.insert((*name).to_owned()) {
                    return Err(format!("duplicate environment name: {name}"));
                }
                environment.push(((*name).to_owned(), (*value).to_owned()));
            }
            ["runtime_ro", value] => {
                let path = validate_absolute("runtime_ro", value)?;
                if !runtime_ro_seen.insert(path.clone()) {
                    return Err(format!("duplicate runtime_ro path: {}", path.display()));
                }
                if runtime_exec_seen.contains(&path) {
                    return Err(format!("runtime path has conflicting access mode: {}", path.display()));
                }
                runtime_read_only.push(path);
            }
            ["runtime_exec", value] => {
                let path = validate_absolute("runtime_exec", value)?;
                if !runtime_exec_seen.insert(path.clone()) {
                    return Err(format!("duplicate runtime_exec path: {}", path.display()));
                }
                if runtime_ro_seen.contains(&path) {
                    return Err(format!("runtime path has conflicting access mode: {}", path.display()));
                }
                runtime_executable.push(path);
            }
            _ => return Err(format!("invalid manifest record at line {line_number}")),
        }
    }

    Ok(Manifest {
        task_id: task_id.ok_or_else(|| "missing task_id".to_owned())?,
        workspace: workspace.ok_or_else(|| "missing workspace".to_owned())?,
        workspace_dev: workspace_dev.ok_or_else(|| "missing workspace_dev".to_owned())?,
        workspace_ino: workspace_ino.ok_or_else(|| "missing workspace_ino".to_owned())?,
        program: program.ok_or_else(|| "missing program".to_owned())?,
        timeout_ms: timeout_ms.ok_or_else(|| "missing timeout_ms".to_owned())?,
        max_output_bytes: max_output_bytes.ok_or_else(|| "missing max_output_bytes".to_owned())?,
        memory_max_bytes: memory_max_bytes.ok_or_else(|| "missing memory_max_bytes".to_owned())?,
        pids_max: pids_max.ok_or_else(|| "missing pids_max".to_owned())?,
        cpu_quota_us: cpu_quota_us.ok_or_else(|| "missing cpu_quota_us".to_owned())?,
        cpu_period_us: cpu_period_us.ok_or_else(|| "missing cpu_period_us".to_owned())?,
        args,
        environment,
        runtime_read_only,
        runtime_executable,
    })
}
