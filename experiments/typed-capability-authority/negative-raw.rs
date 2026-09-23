mod authority;

use authority::*;

fn main() {
    let raw = PresentedPermit {
        id: 1,
        obligation_id: 2,
        claimed_revision: 3,
        claim_commit: 4,
        obligation_key: 5,
        execution_generation: 6,
        execution_authority_commit: 7,
        execution_capability_sha256: 8,
        presented_capability_sha256: 8,
    };

    perform_github_status(raw, || ());
}
