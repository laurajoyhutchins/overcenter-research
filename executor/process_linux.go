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

const confinedDirectoryOpenFlags = syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC

func openWorkspaceRoot(workspaceRoot string) (*os.File, error) {
	if !filepath.IsAbs(workspaceRoot) {
		return nil, errors.New("workspace root must be absolute")
	}
	clean := filepath.Clean(workspaceRoot)
	fd, err := syscall.Open(clean, confinedDirectoryOpenFlags, 0)
	if err != nil {
		return nil, fmt.Errorf("open workspace root: %w", err)
	}
	return os.NewFile(uintptr(fd), clean), nil
}

func openConfinedWorkingDirectory(workspaceRoot *os.File, relative string) (*os.File, error) {
	clean := filepath.Clean(relative)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.IsAbs(clean) {
		return nil, errors.New("cwd escapes workspace")
	}

	parentFD := int(workspaceRoot.Fd())
	var current *os.File
	components := strings.Split(clean, string(filepath.Separator))
	if clean == "." {
		components = []string{"."}
	}
	for _, component := range components {
		if component == "" {
			continue
		}
		fd, err := syscall.Openat(parentFD, component, confinedDirectoryOpenFlags, 0)
		if current != nil {
			_ = current.Close()
			current = nil
		}
		if err != nil {
			return nil, fmt.Errorf("open cwd component %q: %w", component, err)
		}
		current = os.NewFile(uintptr(fd), component)
		parentFD = fd
	}
	if current == nil {
		return nil, errors.New("cwd invalid")
	}
	return current, nil
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
	workspaceRoot *os.File,
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

	cwd, err := openConfinedWorkingDirectory(workspaceRoot, spec.Cwd)
	if err != nil {
		evidence.Error = err.Error()
		return evidence
	}
	cwdPath := fmt.Sprintf("/proc/self/fd/%d", cwd.Fd())

	stdout := newBoundedDigestWriter(spec.StdoutMaxBytes)
	stderr := newBoundedDigestWriter(spec.StderrMaxBytes)
	command := exec.Command(spec.Executable, spec.Argv...)
	command.Dir = cwdPath
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
			Groups:      []uint32{taskCredential.GID},
			NoSetGroups: false,
		}
	}

	if err := command.Start(); err != nil {
		_ = cwd.Close()
		evidence.Error = fmt.Sprintf("start process: %v", err)
		evidence.StdoutSHA256 = stdout.sha256()
		evidence.StderrSHA256 = stderr.sha256()
		return evidence
	}
	_ = cwd.Close()

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

