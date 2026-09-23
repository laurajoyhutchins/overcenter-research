#[path = "../../src/execution/confinement/manifest.rs"]
mod manifest;
#[path = "../../src/execution/confinement/resource.rs"]
mod resource;
#[path = "../../src/execution/confinement/sandbox.rs"]
mod sandbox;

fn forge<'a>(manifest: &'a manifest::Manifest) -> sandbox::ExecPermit<'a> {
    sandbox::ExecPermit {
        manifest,
        landlock_abi: 6,
    }
}

fn main() {}
