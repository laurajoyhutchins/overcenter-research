use std::ffi::c_long;

const SYS_GETPID: c_long = 39;
const X32_SYSCALL_BIT: c_long = 0x40000000;

unsafe extern "C" {
    fn syscall(number: c_long, ...) -> c_long;
}

fn main() {
    let _ = unsafe { syscall(X32_SYSCALL_BIT | SYS_GETPID) };
    eprintln!("x32 syscall namespace was not killed by seccomp");
    std::process::exit(1);
}
