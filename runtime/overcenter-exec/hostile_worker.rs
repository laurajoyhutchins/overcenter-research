use std::env;
use std::fs;
use std::net::TcpStream;
use std::os::unix::net::UnixStream;
use std::path::Path;

const F_GETFD: i32 = 1;
const EBADF: i32 = 9;

unsafe extern "C" {
    fn fcntl(fd: i32, cmd: i32, ...) -> i32;
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

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    must(args.len() == 2, "usage: hostile-worker <outside-read> <outside-write>");
    let outside_read = Path::new(&args[0]);
    let outside_write = Path::new(&args[1]);

    must(fs::read_to_string("allowed.txt").unwrap().trim() == "SAFE", "workspace read failed");
    fs::write("output.txt", "TASK-WRITE\n").unwrap();

    let outside_read_error = fs::read_to_string(outside_read).expect_err("outside read unexpectedly succeeded");
    must(denied(&outside_read_error), "outside read did not fail with an authority denial");

    let outside_write_error = fs::write(outside_write, "PWNED\n").expect_err("outside write unexpectedly succeeded");
    must(denied(&outside_write_error), "outside write did not fail with an authority denial");

    let host_read_error = fs::read_to_string("/etc/passwd").expect_err("undeclared host read unexpectedly succeeded");
    must(denied(&host_read_error), "undeclared host read did not fail with an authority denial");

    must(env::var_os("GITHUB_TOKEN").is_none(), "ambient GITHUB_TOKEN leaked");
    must(env::var_os("AWS_SECRET_ACCESS_KEY").is_none(), "ambient AWS credential leaked");
    must(env::var("OVERCENTER_TEST").as_deref() == Ok("explicit"), "explicit environment missing");

    let fd_state = unsafe { fcntl(200, F_GETFD) };
    must(fd_state == -1, "inherited fd 200 remained open");
    must(std::io::Error::last_os_error().raw_os_error() == Some(EBADF), "fd 200 failed for an unexpected reason");

    let tcp_error = TcpStream::connect("127.0.0.1:9").expect_err("TCP socket unexpectedly available");
    must(denied(&tcp_error), "TCP socket was not denied by policy");

    let unix_error = UnixStream::pair().expect_err("Unix socketpair unexpectedly available");
    must(denied(&unix_error), "Unix socketpair was not denied by policy");

    println!("PASS");
    println!("outside filesystem: denied");
    println!("ambient credentials: absent");
    println!("inherited fd: closed");
    println!("new sockets: denied");
}
