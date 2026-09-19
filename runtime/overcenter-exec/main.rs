#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

mod manifest;
mod sandbox;

use manifest::parse_manifest;
use std::env;
use std::io::{self, Read};
use std::process::ExitCode;

fn fail(message: impl AsRef<str>) -> ! {
    eprintln!("overcenter-exec: {}", message.as_ref());
    std::process::exit(2);
}

fn main() -> ExitCode {
    if env::args_os().skip(1).next().is_some() {
        eprintln!("usage: overcenter-exec < execution-manifest");
        return ExitCode::from(2);
    }

    let result = (|| -> Result<(), String> {
        let mut manifest_bytes = String::new();
        io::stdin()
            .read_to_string(&mut manifest_bytes)
            .map_err(|error| format!("read manifest from stdin: {error}"))?;
        let manifest = parse_manifest(&manifest_bytes)?;
        sandbox::execute(manifest).map_err(|error| error.to_string())
    })();

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => fail(error),
    }
}
