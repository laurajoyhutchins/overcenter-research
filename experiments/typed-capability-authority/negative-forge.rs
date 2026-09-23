mod authority;

use authority::{ExecutionPermit, GithubCommitStatus};

fn main() {
    let _forged = ExecutionPermit::<GithubCommitStatus> {
        _run: std::marker::PhantomData,
        _effect: std::marker::PhantomData,
    };
}
