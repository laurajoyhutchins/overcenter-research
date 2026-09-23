#[path = "../../src/execution/confinement/manifest.rs"]
mod manifest;
#[path = "../../src/execution/confinement/resource.rs"]
mod resource;
#[path = "../../src/execution/confinement/sandbox.rs"]
mod sandbox;

fn consume_twice(permit: sandbox::ExecPermit<'_>) {
    let _ = permit.launch();
    let _ = permit.launch();
}

fn main() {}
