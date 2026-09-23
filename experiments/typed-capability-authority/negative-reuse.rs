mod authority;

use authority::*;

fn main() {
    let run = RunIdentity {
        id: 1,
        obligation_id: 2,
        claimed_revision: 3,
        claim_commit: 4,
        obligation_key: 5,
        execution_generation: 6,
        execution_authority_commit: 7,
        execution_capability_sha256: 8,
    };
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
    let work = ClaimedWork {
        id: 2,
        run_id: 1,
        claimed_revision: 3,
        github_status_effect: true,
        github_status_postcondition: true,
    };
    let lifecycle = Lifecycle {
        run_id: 1,
        executing: true,
    };

    let permit = authorize_github_status(&run, &raw, &work, &lifecycle, false).unwrap();
    perform_github_status(permit, || ());
    perform_github_status(permit, || ());
}
