use std::marker::PhantomData;

#[derive(Clone, Copy, Debug)]
pub struct RunIdentity {
    pub id: u64,
    pub obligation_id: u64,
    pub claimed_revision: u64,
    pub claim_commit: u64,
    pub obligation_key: u64,
    pub execution_generation: u64,
    pub execution_authority_commit: u64,
    pub execution_capability_sha256: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct PresentedPermit {
    pub id: u64,
    pub obligation_id: u64,
    pub claimed_revision: u64,
    pub claim_commit: u64,
    pub obligation_key: u64,
    pub execution_generation: u64,
    pub execution_authority_commit: u64,
    pub execution_capability_sha256: u64,
    pub presented_capability_sha256: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct ClaimedWork {
    pub id: u64,
    pub run_id: u64,
    pub claimed_revision: u64,
    pub github_status_effect: bool,
    pub github_status_postcondition: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Lifecycle {
    pub run_id: u64,
    pub executing: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmissionError {
    GithubStatusEffectRunMismatch,
    GithubStatusEffectNotAuthorized,
    GithubStatusEffectPostconditionMismatch,
    StaleExecutionGeneration,
    RunNotExecuting,
    UnresolvedEffect,
}

#[inline(always)]
pub fn baseline_admission(
    run: &RunIdentity,
    permit: &PresentedPermit,
    work: &ClaimedWork,
    lifecycle: &Lifecycle,
    unresolved_effect: bool,
) -> Result<(), AdmissionError> {
    if work.id != permit.obligation_id
        || work.run_id != permit.id
        || work.claimed_revision != permit.claimed_revision
    {
        return Err(AdmissionError::GithubStatusEffectRunMismatch);
    }
    if !work.github_status_effect {
        return Err(AdmissionError::GithubStatusEffectNotAuthorized);
    }
    if !work.github_status_postcondition {
        return Err(AdmissionError::GithubStatusEffectPostconditionMismatch);
    }

    let current_authority = permit.id == run.id
        && permit.obligation_id == run.obligation_id
        && permit.execution_generation == run.execution_generation
        && permit.execution_authority_commit == run.execution_authority_commit
        && permit.execution_capability_sha256 == run.execution_capability_sha256
        && permit.presented_capability_sha256 == run.execution_capability_sha256;
    let exact_revision = permit.claimed_revision == run.claimed_revision
        && permit.claim_commit == run.claim_commit
        && permit.obligation_key == run.obligation_key;

    if !current_authority || !exact_revision {
        return Err(AdmissionError::StaleExecutionGeneration);
    }
    if lifecycle.run_id != run.id || !lifecycle.executing {
        return Err(AdmissionError::RunNotExecuting);
    }
    if unresolved_effect {
        return Err(AdmissionError::UnresolvedEffect);
    }
    Ok(())
}

mod sealed {
    pub trait Sealed {}
}

pub trait Effect: sealed::Sealed {}

pub struct GithubCommitStatus;
impl sealed::Sealed for GithubCommitStatus {}
impl Effect for GithubCommitStatus {}

pub struct ExecutionPermit<'run, E: Effect> {
    _run: PhantomData<&'run RunIdentity>,
    _effect: PhantomData<E>,
}

#[inline(always)]
pub fn authorize_github_status<'run>(
    run: &'run RunIdentity,
    permit: &PresentedPermit,
    work: &ClaimedWork,
    lifecycle: &Lifecycle,
    unresolved_effect: bool,
) -> Result<ExecutionPermit<'run, GithubCommitStatus>, AdmissionError> {
    if work.id != permit.obligation_id
        || work.run_id != permit.id
        || work.claimed_revision != permit.claimed_revision
    {
        return Err(AdmissionError::GithubStatusEffectRunMismatch);
    }
    if !work.github_status_effect {
        return Err(AdmissionError::GithubStatusEffectNotAuthorized);
    }
    if !work.github_status_postcondition {
        return Err(AdmissionError::GithubStatusEffectPostconditionMismatch);
    }

    if permit.id != run.id
        || permit.obligation_id != run.obligation_id
        || permit.execution_generation != run.execution_generation
        || permit.execution_authority_commit != run.execution_authority_commit
        || permit.execution_capability_sha256 != run.execution_capability_sha256
        || permit.presented_capability_sha256 != run.execution_capability_sha256
        || permit.claimed_revision != run.claimed_revision
        || permit.claim_commit != run.claim_commit
        || permit.obligation_key != run.obligation_key
    {
        return Err(AdmissionError::StaleExecutionGeneration);
    }
    if lifecycle.run_id != run.id || !lifecycle.executing {
        return Err(AdmissionError::RunNotExecuting);
    }
    if unresolved_effect {
        return Err(AdmissionError::UnresolvedEffect);
    }

    Ok(ExecutionPermit {
        _run: PhantomData,
        _effect: PhantomData,
    })
}

#[inline(always)]
pub fn perform_github_status<R>(
    _permit: ExecutionPermit<'_, GithubCommitStatus>,
    effect: impl FnOnce() -> R,
) -> R {
    effect()
}
