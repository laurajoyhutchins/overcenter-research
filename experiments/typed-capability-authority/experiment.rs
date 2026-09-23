mod authority;

use authority::*;
use std::hint::black_box;
use std::sync::Arc;
use std::time::{Duration, Instant};

const CHECKS: usize = 17;

fn valid() -> (RunIdentity, PresentedPermit, ClaimedWork, Lifecycle, bool) {
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
    let permit = PresentedPermit {
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
    (run, permit, work, lifecycle, false)
}

fn case(mask: usize) -> (RunIdentity, PresentedPermit, ClaimedWork, Lifecycle, bool) {
    let (run, mut permit, mut work, mut lifecycle, mut unresolved) = valid();

    if mask & (1 << 0) != 0 { work.id += 100; }
    if mask & (1 << 1) != 0 { work.run_id += 100; }
    if mask & (1 << 2) != 0 { work.claimed_revision += 100; }
    if mask & (1 << 3) != 0 { work.github_status_effect = false; }
    if mask & (1 << 4) != 0 { work.github_status_postcondition = false; }
    if mask & (1 << 5) != 0 { permit.id += 100; }
    if mask & (1 << 6) != 0 { permit.obligation_id += 100; }
    if mask & (1 << 7) != 0 { permit.execution_generation += 100; }
    if mask & (1 << 8) != 0 { permit.execution_authority_commit += 100; }
    if mask & (1 << 9) != 0 { permit.execution_capability_sha256 += 100; }
    if mask & (1 << 10) != 0 { permit.presented_capability_sha256 += 100; }
    if mask & (1 << 11) != 0 { permit.claimed_revision += 100; }
    if mask & (1 << 12) != 0 { permit.claim_commit += 100; }
    if mask & (1 << 13) != 0 { permit.obligation_key += 100; }
    if mask & (1 << 14) != 0 { lifecycle.run_id += 100; }
    if mask & (1 << 15) != 0 { lifecycle.executing = false; }
    if mask & (1 << 16) != 0 { unresolved = true; }

    (run, permit, work, lifecycle, unresolved)
}

fn security_differential() {
    let mut admitted = 0usize;

    for mask in 0..(1usize << CHECKS) {
        let (run, permit, work, lifecycle, unresolved) = case(mask);
        let baseline = baseline_admission(&run, &permit, &work, &lifecycle, unresolved);
        let typed = authorize_github_status(&run, &permit, &work, &lifecycle, unresolved);

        assert_eq!(
            baseline.as_ref().err(),
            typed.as_ref().err(),
            "authority decision diverged for mask={mask:#x}"
        );

        if let Ok(capability) = typed {
            admitted += perform_github_status(capability, || 1usize);
        }
    }

    assert_eq!(
        admitted, 1,
        "only the fully valid authority tuple may cross the effect boundary"
    );
    println!(
        "security: PASS {} hostile authority combinations + valid control",
        (1usize << CHECKS) - 1
    );
}

fn median(mut values: Vec<Duration>) -> Duration {
    values.sort();
    values[values.len() / 2]
}

fn bench_once(iterations: usize, typed: bool) -> Duration {
    let (run, permit, work, lifecycle, unresolved) = valid();
    let started = Instant::now();
    let mut effects = 0usize;

    for _ in 0..iterations {
        if typed {
            let capability = authorize_github_status(
                black_box(&run),
                black_box(&permit),
                black_box(&work),
                black_box(&lifecycle),
                black_box(unresolved),
            ).unwrap();
            effects += perform_github_status(capability, || 1usize);
        } else {
            baseline_admission(
                black_box(&run),
                black_box(&permit),
                black_box(&work),
                black_box(&lifecycle),
                black_box(unresolved),
            ).unwrap();
            effects += black_box(1usize);
        }
    }

    black_box(effects);
    started.elapsed()
}

fn sequential_benchmark() {
    const ITERATIONS: usize = 2_000_000;
    const ROUNDS: usize = 7;

    let mut baseline = Vec::new();
    let mut typed = Vec::new();

    for round in 0..ROUNDS {
        if round % 2 == 0 {
            baseline.push(bench_once(ITERATIONS, false));
            typed.push(bench_once(ITERATIONS, true));
        } else {
            typed.push(bench_once(ITERATIONS, true));
            baseline.push(bench_once(ITERATIONS, false));
        }
    }

    let baseline_median = median(baseline);
    let typed_median = median(typed);
    let ratio = typed_median.as_secs_f64() / baseline_median.as_secs_f64();

    println!(
        "sequential: baseline={baseline_median:?} typed={typed_median:?} ratio={ratio:.3}"
    );
    assert!(
        ratio <= 1.10,
        "typed sequential admission regressed >10%: ratio={ratio:.3}"
    );
}

fn concurrent_once(threads: usize, per_thread: usize, typed: bool) -> Duration {
    let state = Arc::new(valid());
    let started = Instant::now();
    let mut handles = Vec::new();

    for _ in 0..threads {
        let state = Arc::clone(&state);
        handles.push(std::thread::spawn(move || {
            let (run, permit, work, lifecycle, unresolved) = *state;
            let mut effects = 0usize;

            for _ in 0..per_thread {
                if typed {
                    let capability = authorize_github_status(
                        black_box(&run),
                        black_box(&permit),
                        black_box(&work),
                        black_box(&lifecycle),
                        black_box(unresolved),
                    ).unwrap();
                    effects += perform_github_status(capability, || 1usize);
                } else {
                    baseline_admission(
                        black_box(&run),
                        black_box(&permit),
                        black_box(&work),
                        black_box(&lifecycle),
                        black_box(unresolved),
                    ).unwrap();
                    effects += black_box(1usize);
                }
            }

            black_box(effects)
        }));
    }

    for handle in handles {
        handle.join().unwrap();
    }

    started.elapsed()
}

fn concurrent_benchmark() {
    const ROUNDS: usize = 5;
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .clamp(2, 8);
    let per_thread = 1_000_000usize;

    let mut baseline = Vec::new();
    let mut typed = Vec::new();

    for round in 0..ROUNDS {
        if round % 2 == 0 {
            baseline.push(concurrent_once(threads, per_thread, false));
            typed.push(concurrent_once(threads, per_thread, true));
        } else {
            typed.push(concurrent_once(threads, per_thread, true));
            baseline.push(concurrent_once(threads, per_thread, false));
        }
    }

    let baseline_median = median(baseline);
    let typed_median = median(typed);
    let ratio = typed_median.as_secs_f64() / baseline_median.as_secs_f64();

    println!(
        "concurrent: threads={threads} baseline={baseline_median:?} typed={typed_median:?} ratio={ratio:.3}"
    );
    assert!(
        ratio <= 1.10,
        "typed concurrent admission regressed >10%: ratio={ratio:.3}"
    );
}

fn main() {
    security_differential();
    sequential_benchmark();
    concurrent_benchmark();

    assert_eq!(
        std::mem::size_of::<ExecutionPermit<'static, GithubCommitStatus>>(),
        0
    );
    assert!(!std::mem::needs_drop::<ExecutionPermit<'static, GithubCommitStatus>>());
    println!(
        "representation: PASS zero-sized affine capability; runtime checks remain at authority ingress"
    );
}
