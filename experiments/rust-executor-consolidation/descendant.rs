use std::hint::spin_loop;

unsafe extern "C" {
    fn fork() -> i32;
}

fn main() {
    let pid = unsafe { fork() };
    if pid < 0 {
        eprintln!("fork failed: {}", std::io::Error::last_os_error());
        std::process::exit(1);
    }
    if pid == 0 {
        loop { spin_loop(); }
    }
}
