//go:build linux

package executor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

const terminationGrace = 250 * time.Millisecond

func baseEvidence(execution ComputationExecutionV1) ComputationAttemptEvidenceV1 {
	emptyStdout := newBoundedDigestWriter(0)
	emptyStderr := newBoundedDigestWriter(0)
	return ComputationAttemptEvidenceV1{
		Schema:                    ComputationEvidenceSchema,
		RunID:                     execution.RunID,
		ObligationID:              execution.ObligationID,
		ClaimedRevision:           execution.ClaimedRevision,
		ExecutionGeneration:       execution.ExecutionGeneration,
		ExecutionAuthorityCommit:  execution.ExecutionAuthorityCommit,
		ExecutionCapabilitySHA256: execution.ExecutionCapabilitySHA256,
		ExecutionSpecSHA256:       execution.ExecutionSpecSHA256,
		Outcome:                   "failed",
		StdoutSHA256:              emptyStdout.sha256(),
		StderrSHA256:              emptyStderr.sha256(),
	}
}

func explicitEnvironment(environment map[string]string) []string {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	values := make([]string, 0, len(keys))
	for _, key := range keys {
		values = append(values, key+"="+environment[key])
	}
	return values
}

func confinedWorkingDirectory(workspaceRoot, relative string) (string, error) {
	root, err := filepath.EvalSymlinks(workspaceRoot)
	if err != nil {
		return "", fmt.Errorf("resolve workspace root: %w", err)
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("absolute workspace root: %w", err)
	}

	candidate := filepath.Join(root, relative)
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve cwd: %w", err)
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", fmt.Errorf("absolute cwd: %w", err)
	}
	within, err := filepath.Rel(root, resolved)
	if err != nil {
		return "", fmt.Errorf("relativize cwd: %w", err)
	}
	if within == ".." || strings.HasPrefix(within, ".."+string(filepath.Separator)) || filepath.IsAbs(within) {
		return "", errors.New("cwd escapes workspace after symlink resolution")
	}
	return resolved, nil
}

func killProcessGroup(pid int, signal syscall.Signal) error {
	err := syscall.Kill(-pid, signal)
	if err == nil || errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func waitAfterCancellation(command *exec.Cmd, wait <-chan error) error {
	if command.Process == nil {
		return nil
	}
	if err := killProcessGroup(command.Process.Pid, syscall.SIGTERM); err != nil {
		return err
	}

	timer := time.NewTimer(terminationGrace)
	defer timer.Stop()

	var waitErr error
	parentExited := false
	select {
	case waitErr = <-wait:
		parentExited = true
		// The parent exiting does not prove its process group is empty.
		// Give descendants the same grace period before fencing the group.
		<-timer.C
	case <-timer.C:
	}

	if err := killProcessGroup(command.Process.Pid, syscall.SIGKILL); err != nil {
		return err
	}
	if !parentExited {
		waitErr = <-wait
	}
	return waitErr
}

func runProcess(
	ctx context.Context,
	workspaceRoot string,
	taskCredential *TaskCredential,
	validated validatedExecution,
) ComputationAttemptEvidenceV1 {
	execution := validated.Execution
	spec := validated.Spec
	evidence := baseEvidence(execution)

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(spec.TimeoutMillis)*time.Millisecond)
	defer cancel()
	if err := runCtx.Err(); err != nil {
		evidence.Outcome = "cancelled"
		evidence.Error = err.Error()
		return evidence
	}

	cwd, err := confinedWorkingDirectory(workspaceRoot, spec.Cwd)
	if err != nil {
		evidence.Error = err.Error()
		return evidence
	}

	stdout := newBoundedDigestWriter(spec.StdoutMaxBytes)
	stderr := newBoundedDigestWriter(spec.StderrMaxBytes)
	command := exec.Command(spec.Executable, spec.Argv...)
	command.Dir = cwd
	command.Env = explicitEnvironment(spec.Env)
	command.Stdout = stdout
	command.Stderr = stderr
	command.SysProcAttr = &syscall.SysProcAttr{
		Setpgid:   true,
		Pdeathsig: syscall.SIGKILL,
	}
	if taskCredential != nil {
		command.SysProcAttr.Credential = &syscall.Credential{
			Uid:         taskCredential.UID,
			Gid:         taskCredential.GID,
			NoSetGroups: true,
		}
	}

	if err := command.Start(); err != nil {
		evidence.Error = fmt.Sprintf("start process: %v", err)
		evidence.StdoutSHA256 = stdout.sha256()
		evidence.StderrSHA256 = stderr.sha256()
		return evidence
	}

	wait := make(chan error, 1)
	go func() {
		wait <- command.Wait()
	}()

	var waitErr error
	cancelled := false
	select {
	case waitErr = <-wait:
	case <-runCtx.Done():
		cancelled = true
		waitErr = waitAfterCancellation(command, wait)
	}

	evidence.StdoutBase64 = stdout.base64()
	evidence.StdoutSHA256 = stdout.sha256()
	evidence.StdoutTruncated = stdout.truncated()
	evidence.StderrBase64 = stderr.base64()
	evidence.StderrSHA256 = stderr.sha256()
	evidence.StderrTruncated = stderr.truncated()

	if command.ProcessState != nil {
		if status, ok := command.ProcessState.Sys().(syscall.WaitStatus); ok {
			if status.Exited() {
				code := status.ExitStatus()
				evidence.ExitCode = &code
			}
			if status.Signaled() {
				evidence.Signal = status.Signal().String()
			}
		}
	}

	if cancelled {
		evidence.Outcome = "cancelled"
		evidence.Error = runCtx.Err().Error()
		return evidence
	}
	if waitErr != nil {
		evidence.Outcome = "failed"
		evidence.Error = waitErr.Error()
		return evidence
	}
	evidence.Outcome = "completed"
	return evidence
}

func validateWorkspaceRoot(workspaceRoot string) (string, error) {
	if !filepath.IsAbs(workspaceRoot) {
		return "", errors.New("workspace root must be absolute")
	}
	info, err := os.Stat(workspaceRoot)
	if err != nil {
		return "", fmt.Errorf("workspace root unavailable: %w", err)
	}
	if !info.IsDir() {
		return "", errors.New("workspace root must be a directory")
	}
	return filepath.Clean(workspaceRoot), nil
}
