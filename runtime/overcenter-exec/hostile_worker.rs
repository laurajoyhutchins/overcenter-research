use std::env;
use std::fs;
use std::net::TcpStream;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::Command;

const F_GETFD: i32 = 1;
const EBADF: i32 = 9;
const EPERM: i32 = 1;
const SIGCONT: i32 = 18;
const SYS_SHMGET: i64 = 29;
const SYS_SEMGET: i64 = 64;
const SYS_MSGGET: i64 = 68;
const SYS_SETPGID: i64 = 109;
const SYS_SETSID: i64 = 112;
const SYS_SCHED_SETAFFINITY: i64 = 203;
const SYS_MQ_OPEN: i64 = 240;
const SYS_PRLIMIT64: i64 = 302;
const SYS_ADD_KEY: i64 = 248;
const SYS_REQUEST_KEY: i64 = 249;
const SYS_KEYCTL: i64 = 250;
const KEYCTL_GET_KEYRING_ID: i64 = 0;
const KEY_SPEC_SESSION_KEYRING: i64 = -3;

unsafe extern "C" {
    fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    fn getppid() -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
    fn syscall(number: i64, ...) -> i64;
}

fn must(condition: bool, message: &str) {
    if !condition {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

fn denied(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(1) | Some(13))
}

fn must_syscall_denied(result: i64, name: &str) {
    if result != -1 {
        eprintln!("{name} unexpectedly available");
        std::process::exit(1);
    }
    if std::io::Error::last_os_error().raw_os_error() != Some(EPERM) {
        eprintln!("{name} failed for an unexpected reason");
        std::process::exit(1);
    }
}

fn must_fd_closed(fd: i32) {
    let state = unsafe { fcntl(fd, F_GETFD) };
    must(state == -1, &format!("inherited fd {fd} remained open"));
    must(
        std::io::Error::last_os_error().raw_os_error() == Some(EBADF),
        &format!("fd {fd} failed for an unexpected reason"),
    );
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    must(args.len() == 2, "usage: hostile-worker <outside-read> <outside-write>");
    let outside_read = Path::new(&args[0]);
    let outside_write = Path::new(&args[1]);

    must(fs::read_to_string("allowed.txt").unwrap().trim() == "SAFE", "workspace read failed");
    fs::write("output.txt", "TASK-WRITE\n").unwrap();

    let sibling_exec_error = Command::new("./undeclared-executable")
        .status()
        .expect_err("undeclared workspace executable unexpectedly ran");
    must(denied(&sibling_exec_error), "undeclared workspace execute was not denied by policy");

    let outside_read_error = fs::read_to_string(outside_read).expect_err("outside read unexpectedly succeeded");
    must(denied(&outside_read_error), "outside read did not fail with an authority denial");

    let outside_write_error = fs::write(outside_write, "PWNED\n").expect_err("outside write unexpectedly succeeded");
    must(denied(&outside_write_error), "outside write did not fail with an authority denial");

    let host_read_error = fs::read_to_string("/etc/passwd").expect_err("undeclared host read unexpectedly succeeded");
    must(denied(&host_read_error), "undeclared host read did not fail with an authority denial");

    must(env::var_os("GITHUB_TOKEN").is_none(), "ambient GITHUB_TOKEN leaked");
    must(env::var_os("AWS_SECRET_ACCESS_KEY").is_none(), "ambient AWS credential leaked");
    must(env::var("OVERCENTER_TEST").as_deref() == Ok("explicit"), "explicit environment missing");

    must_fd_closed(3);
    must_fd_closed(4);
    must_fd_closed(200);

    let parent = unsafe { getppid() };
    let signal_state = unsafe { kill(parent, SIGCONT) };
    must(signal_state == -1, "signal escaped the Landlock process scope");
    must(
        std::io::Error::last_os_error().raw_os_error() == Some(EPERM),
        "outside-domain signal failed for an unexpected reason",
    );

    must_syscall_denied(unsafe { syscall(SYS_SETPGID, 0_i64, 0_i64) }, "setpgid");
    must_syscall_denied(unsafe { syscall(SYS_SETSID) }, "setsid");
    must_syscall_denied(
        unsafe { syscall(SYS_SCHED_SETAFFINITY, parent, 0_usize, std::ptr::null::<u8>()) },
        "sched_setaffinity",
    );
    must_syscall_denied(
        unsafe { syscall(SYS_PRLIMIT64, parent, -1_i64, std::ptr::null::<u8>(), std::ptr::null_mut::<u8>()) },
        "prlimit64",
    );

    must_syscall_denied(
        unsafe {
            syscall(
                SYS_KEYCTL,
                KEYCTL_GET_KEYRING_ID,
                KEY_SPEC_SESSION_KEYRING,
                1_i64,
            )
        },
        "keyctl",
    );
    must_syscall_denied(
        unsafe {
            syscall(
                SYS_ADD_KEY,
                b"user\0".as_ptr(),
                b"overcenter-hostile\0".as_ptr(),
                b"x".as_ptr(),
                1_usize,
                KEY_SPEC_SESSION_KEYRING,
            )
        },
        "add_key",
    );
    must_syscall_denied(
        unsafe {
            syscall(
                SYS_REQUEST_KEY,
                b"user\0".as_ptr(),
                b"overcenter-hostile\0".as_ptr(),
                std::ptr::null::<u8>(),
                KEY_SPEC_SESSION_KEYRING,
            )
        },
        "request_key",
    );

    const HOST_IPC_KEY: i64 = 0x6f76_6572;
    must_syscall_denied(unsafe { syscall(SYS_SHMGET, HOST_IPC_KEY, 1_usize, 0_i64) }, "shmget");
    must_syscall_denied(unsafe { syscall(SYS_SEMGET, HOST_IPC_KEY, 1_i64, 0_i64) }, "semget");
    must_syscall_denied(unsafe { syscall(SYS_MSGGET, HOST_IPC_KEY, 0_i64) }, "msgget");
    must_syscall_denied(
        unsafe {
            syscall(
                SYS_MQ_OPEN,
                b"/overcenter-red-team-nonexistent\0".as_ptr(),
                0_i64,
                0_i64,
                std::ptr::null::<u8>(),
            )
        },
        "mq_open",
    );

    let tcp_error = TcpStream::connect("127.0.0.1:9").expect_err("TCP socket unexpectedly available");
    must(denied(&tcp_error), "TCP socket was not denied by policy");

    let unix_error = UnixStream::pair().expect_err("Unix socketpair unexpectedly available");
    must(denied(&unix_error), "Unix socketpair was not denied by policy");

    println!("PASS");
    println!("workspace execute: explicit-only");
    println!("outside filesystem: denied");
    println!("ambient credentials: absent");
    println!("workspace/cgroup authority fds: closed");
    println!("inherited fd: closed");
    println!("outside-domain signals: denied");
    println!("process-group escape: denied");
    println!("same-uid host process control: denied");
    println!("kernel keyrings: denied");
    println!("host IPC namespaces: denied");
    println!("new sockets: denied");
}
