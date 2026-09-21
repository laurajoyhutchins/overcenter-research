use std::env;
use std::io;
use std::time::{Duration, Instant};

const EAGAIN: i32 = 11;

unsafe extern "C" {
    fn fork() -> i32;
    fn pause() -> i32;
}

fn pids_probe() {
    let mut children = 0usize;
    loop {
        let pid = unsafe { fork() };
        if pid == 0 {
            loop {
                unsafe { pause() };
            }
        }
        if pid < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(EAGAIN) && children > 0 {
                println!("PIDS_LIMIT children={children}");
                return;
            }
            eprintln!("fork failed unexpectedly after {children} children: {error}");
            std::process::exit(1);
        }
        children += 1;
        if children > 1024 {
            eprintln!("pids limit did not stop fork growth");
            std::process::exit(1);
        }
    }
}

fn cpu_probe() {
    let started = Instant::now();
    let mut value = 1u64;
    while started.elapsed() < Duration::from_millis(750) {
        value = value.wrapping_mul(6364136223846793005).wrapping_add(1);
        std::hint::black_box(value);
    }
    println!("CPU_BUSY");
}

fn memory_probe() {
    let mut blocks: Vec<Vec<u8>> = Vec::new();
    loop {
        let mut block = vec![0u8; 1024 * 1024];
        for offset in (0..block.len()).step_by(4096) {
            block[offset] = 1;
        }
        blocks.push(block);
        if blocks.len() > 4096 {
            eprintln!("memory limit did not terminate allocation growth");
            std::process::exit(1);
        }
    }
}

fn main() {
    match env::args().nth(1).as_deref() {
        Some("pids") => pids_probe(),
        Some("cpu") => cpu_probe(),
        Some("memory") => memory_probe(),
        _ => {
            eprintln!("usage: resource-probe <pids|cpu|memory>");
            std::process::exit(2);
        }
    }
}
